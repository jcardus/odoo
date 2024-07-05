import { Plugin } from "../plugin";
import { closestBlock, isBlock } from "../utils/blocks";
import {
    isEmpty,
    isInPre,
    isNotEditableNode,
    isSelfClosingElement,
    isShrunkBlock,
    isTangible,
    isUnbreakable,
    isVisibleTextNode,
    isWhitespace,
    isZWS,
    nextLeaf,
    previousLeaf,
} from "../utils/dom_info";
import { getState, isFakeLineBreak, prepareUpdate } from "../utils/dom_state";
import {
    childNodes,
    closestElement,
    findUpTo,
    descendants,
    firstLeaf,
    getCommonAncestor,
    getFurthestUneditableParent,
    lastLeaf,
} from "../utils/dom_traversal";
import { DIRECTIONS, childNodeIndex, leftPos, nodeSize, rightPos } from "../utils/position";
import { CTYPES } from "../utils/content_types";
import { isMacOS } from "@web/core/browser/feature_detection";

/**
 * @typedef {Object} RangeLike
 * @property {Node} startContainer
 * @property {number} startOffset
 * @property {Node} endContainer
 * @property {number} endOffset
 */

/** @typedef {import("@html_editor/core/selection_plugin").EditorSelection} EditorSelection */

const beforeInputHandlers = {
    deleteContentBackward: "DELETE_BACKWARD",
    deleteContentForward: "DELETE_FORWARD",
    deleteWordBackward: "DELETE_BACKWARD_WORD",
    deleteWordForward: "DELETE_FORWARD_WORD",
    deleteHardLineBackward: "DELETE_BACKWARD_LINE",
    deleteHardLineForward: "DELETE_FORWARD_LINE",
};

export class DeletePlugin extends Plugin {
    static dependencies = ["selection"];
    static name = "delete";
    static shared = ["deleteRange"];
    /** @type { (p: DeletePlugin) => Record<string, any> } */
    static resources = (p) => ({
        shortcuts: [
            { hotkey: "backspace", command: "DELETE_BACKWARD" },
            { hotkey: "delete", command: "DELETE_FORWARD" },
            { hotkey: "control+backspace", command: "DELETE_BACKWARD_WORD" },
            { hotkey: "control+delete", command: "DELETE_FORWARD_WORD" },
            { hotkey: "control+shift+backspace", command: "DELETE_BACKWARD_LINE" },
            { hotkey: "control+shift+delete", command: "DELETE_FORWARD_LINE" },
        ],
        handle_delete_backward: [{ callback: p.deleteBackwardUnmergeable.bind(p) }],
        handle_delete_backward_word: { callback: p.deleteBackwardUnmergeable.bind(p) },
        handle_delete_backward_line: { callback: p.deleteBackwardUnmergeable.bind(p) },
        handle_delete_forward: { callback: p.deleteForwardUnmergeable.bind(p) },
        handle_delete_forward_word: { callback: p.deleteForwardUnmergeable.bind(p) },
        handle_delete_forward_line: { callback: p.deleteForwardUnmergeable.bind(p) },

        // @todo @phoenix: move these predicates to different plugins
        unremovables: [
            // The root editable (@todo @phoenix: I don't think this is necessary)
            (element) => element.classList.contains("odoo-editor-editable"),
            // Website stuff?
            (element) => element.classList.contains("o_editable"),
            (element) => element.classList.contains("oe_unremovable"),
            // QWeb directives
            (element) => element.getAttribute("t-set") || element.getAttribute("t-call"),
            // Monetary field
            (element) => element.matches("[data-oe-type='monetary'] > span"),
        ],
    });

    setup() {
        this.addDomListener(this.editable, "beforeinput", this.onBeforeInput.bind(this));
        this.addDomListener(this.editable, "keydown", this.onKeydown.bind(this));
    }

    handleCommand(command, payload) {
        switch (command) {
            case "DELETE_SELECTION":
                this.deleteSelection();
                break;
            case "DELETE_BACKWARD":
                this.delete("backward", "character");
                break;
            case "DELETE_FORWARD":
                this.delete("forward", "character");
                break;
            case "DELETE_BACKWARD_WORD":
                this.delete("backward", "word");
                break;
            case "DELETE_FORWARD_WORD":
                this.delete("forward", "word");
                break;
            case "DELETE_BACKWARD_LINE":
                this.delete("backward", "line");
                break;
            case "DELETE_FORWARD_LINE":
                this.delete("forward", "line");
                break;
        }
    }

    // --------------------------------------------------------------------------
    // commands
    // --------------------------------------------------------------------------

    /**
     * @param {EditorSelection} [selection]
     */
    deleteSelection(selection = this.shared.getEditableSelection()) {
        // @todo @phoenix: handle non-collapsed selection around a ZWS
        // see collapseIfZWS

        // Normalize selection
        selection = this.shared.setSelection(selection);

        if (selection.isCollapsed) {
            return;
        }

        let range = this.adjustRange(selection, [
            this.correctTripleClick,
            this.expandRangeToIncludeNonEditables,
            this.includeEndOrStartBlock,
            this.fullyIncludeLinks,
        ]);

        for (const { callback } of this.resources["handle_delete_range"]) {
            if (callback(range)) {
                return;
            }
        }

        range = this.deleteRange(range);
        this.setCursorFromRange(range);
    }

    /**
     * @param {"backward"|"forward"} direction
     * @param {"character"|"word"} granularity
     */
    delete(direction, granularity) {
        const selection = this.shared.getEditableSelection();

        if (!selection.isCollapsed) {
            this.deleteSelection(selection);
        } else if (direction === "backward") {
            this.deleteBackward(selection, granularity);
        } else if (direction === "forward") {
            this.deleteForward(selection, granularity);
        } else {
            throw new Error("Invalid direction");
        }

        this.dispatch("ADD_STEP");
    }

    // --------------------------------------------------------------------------
    // Delete backward/forward
    // --------------------------------------------------------------------------

    /**
     * @param {EditorSelection} selection
     * @param {"character"|"word"} granularity
     */
    deleteBackward(selection, granularity) {
        // Normalize selection
        selection = this.shared.setSelection(selection);

        let range = this.getRangeForDeleteBackward(selection, granularity);

        const resources = {
            character: this.resources["handle_delete_backward"],
            word: this.resources["handle_delete_backward_word"],
            line: this.resources["handle_delete_backward_line"],
        };
        for (const { callback } of resources[granularity]) {
            if (callback(range)) {
                return;
            }
        }

        range = this.adjustRange(range, [
            this.includeEmptyInlineEnd,
            this.includePreviousZWS,
            this.includeEndOrStartBlock,
        ]);
        range = this.deleteRange(range);
        this.setCursorFromRange(range, { collapseToEnd: true });
    }

    /**
     * @param {EditorSelection} selection
     * @param {"character"|"word"} granularity
     */
    deleteForward(selection, granularity) {
        // Normalize selection
        selection = this.shared.setSelection(selection);

        let range = this.getRangeForDeleteForward(selection, granularity);

        const resources = {
            character: this.resources["handle_delete_forward"],
            word: this.resources["handle_delete_forward_word"],
            line: this.resources["handle_delete_forward_line"],
        };
        for (const { callback } of resources[granularity]) {
            if (callback(range)) {
                return;
            }
        }

        range = this.adjustRange(range, [
            this.includeEmptyInlineStart,
            this.includeNextZWS,
            this.includeEndOrStartBlock,
        ]);
        range = this.deleteRange(range);
        this.setCursorFromRange(range);
    }

    getRangeForDeleteBackward(selection, granularity) {
        const { endContainer, endOffset } = selection;
        let startContainer, startOffset;

        switch (granularity) {
            case "character":
                [startContainer, startOffset] = this.findPreviousPosition(endContainer, endOffset);
                break;
            case "word":
                // @todo @phoenix: write more tests for ctrl+delete
                ({ startContainer, startOffset } = this.shared.modifySelection(
                    "extend",
                    "backward",
                    "word"
                ));
                break;
            case "line":
                [startContainer, startOffset] = this.findPreviousLineBoundary(
                    endContainer,
                    endOffset
                );
                break;
            default:
                throw new Error("Invalid granularity");
        }

        if (!startContainer) {
            [startContainer, startOffset] = [endContainer, endOffset];
        }
        return { startContainer, startOffset, endContainer, endOffset };
    }

    getRangeForDeleteForward(selection, granularity) {
        const { startContainer, startOffset } = selection;
        let endContainer, endOffset;

        switch (granularity) {
            case "character":
                [endContainer, endOffset] = this.findNextPosition(startContainer, startOffset);
                break;
            case "word":
                // @todo @phoenix: write more tests for ctrl+delete
                ({ endContainer, endOffset } = this.shared.modifySelection(
                    "extend",
                    "forward",
                    "word"
                ));
                break;
            case "line":
                [endContainer, endOffset] = this.findNextLineBoundary(startContainer, startOffset);
                break;
            default:
                throw new Error("Invalid granularity");
        }

        if (!endContainer) {
            [endContainer, endOffset] = [startContainer, startOffset];
        }
        return { startContainer, startOffset, endContainer, endOffset };
    }

    // --------------------------------------------------------------------------
    // Delete range
    // --------------------------------------------------------------------------

    /*
    Inline:
        Empty inlines get filled, no joining.
        <b>[abc]</b> -> <b>[]ZWS</b>
        <b>[abc</b> <b>d]ef</b> -> <b>[]ZWS</b> <b>ef</b>
        <b>[abc</b> <b>def]</b> -> <b>[]ZWS</b> <b>ZWS</b>
        
    Block:
        Shrunk blocks get filled.
        <p>[abc]</p> -> <p>[]<br></p>

        End block's content is appended to start block on join.
        <h1>a[bc</h1> <p>de]f</p> -> <h1>a[]f</h1>
        <h1>[abc</h1> <p>def]</p> -> <h1>[]<br></h1>

        To make left block disappear instead, use this range:
        [<h1>abc</h1> <p>de]f</p> -> []<p>f</p> (which can be normalized later, see setCursorFromRange)

    Block + Inline:
        Inline content after block is appended to block on join.
        <p>a[bc</p> d]ef -> <p>a[]ef</p>

    Inline + Block:
        Block content is unwrapped on join.
        ab[c <p>de]f</p> -> ab[]f
        ab[c <p>de]f</p> ghi -> ab[]f<br>ghi

    */

    /**
     * Removes (removable) nodes and merges block with block/inline when
     * applicable (and mergeable).
     * Returns the updated range, which is collapsed to start if the original
     * range could be completely deleted and merged.
     *
     * @param {RangeLike} range
     * @returns {RangeLike}
     */
    deleteRange(range) {
        // Do nothing if the range is collapsed.
        if (range.startContainer === range.endContainer && range.startOffset === range.endOffset) {
            return range;
        }
        // Split text nodes in order to have elements as start/end containers.
        range = this.splitTextNodes(range);

        const { startContainer, startOffset, endContainer, endOffset } = range;
        const restoreSpaces = prepareUpdate(startContainer, startOffset, endContainer, endOffset);

        let restoreFakeBRs;
        ({ restoreFakeBRs, range } = this.removeFakeBRs(range));

        // Remove nodes.
        let allNodesRemoved;
        ({ allNodesRemoved, range } = this.removeNodes(range));

        this.fillEmptyInlines(range);

        // Join fragments.
        const originalCommonAncestor = range.commonAncestorContainer;
        if (allNodesRemoved) {
            range = this.joinFragments(range);
        }

        restoreFakeBRs();
        this.fillShrunkBlocks(originalCommonAncestor);
        restoreSpaces();

        return range;
    }

    splitTextNodes({ startContainer, startOffset, endContainer, endOffset }) {
        // Splits text nodes only if necessary.
        const split = (textNode, offset) => {
            let didSplit = false;
            if (offset === 0) {
                offset = childNodeIndex(textNode);
            } else if (offset === nodeSize(textNode)) {
                offset = childNodeIndex(textNode) + 1;
            } else {
                textNode.splitText(offset);
                didSplit = true;
                offset = childNodeIndex(textNode) + 1;
            }
            return [textNode.parentElement, offset, didSplit];
        };

        if (endContainer.nodeType === Node.TEXT_NODE) {
            [endContainer, endOffset] = split(endContainer, endOffset);
        }
        if (startContainer.nodeType === Node.TEXT_NODE) {
            let didSplit;
            [startContainer, startOffset, didSplit] = split(startContainer, startOffset);
            if (startContainer === endContainer && didSplit) {
                endOffset += 1;
            }
        }

        return {
            startContainer,
            startOffset,
            endContainer,
            endOffset,
            commonAncestorContainer: getCommonAncestor(
                [startContainer, endContainer],
                this.editable
            ),
        };
    }

    // Removes fake line breaks, so that each BR left is an actual line break.
    // Returns the updated range and a function to later restore the fake BRs.
    removeFakeBRs(range) {
        let { startContainer, startOffset, endContainer, endOffset, commonAncestorContainer } =
            range;
        const getLastBrChild = (node) =>
            [...node.childNodes].filter((child) => child.nodeName === "BR").pop();
        const visitedNodes = new Set();
        const removeBRs = (container, offset) => {
            let node = container;
            while (node !== commonAncestorContainer) {
                const lastBR = getLastBrChild(node);
                if (lastBR && isFakeLineBreak(lastBR)) {
                    if (node === container && offset > childNodeIndex(lastBR)) {
                        offset -= 1;
                    }
                    lastBR.remove();
                }
                visitedNodes.add(node);
                node = node.parentNode;
            }
            return offset;
        };
        startOffset = removeBRs(startContainer, startOffset);
        endOffset = removeBRs(endContainer, endOffset);

        const restoreFakeBRs = () => {
            for (const node of visitedNodes) {
                if (!node.isConnected) {
                    continue;
                }
                const lastBR = getLastBrChild(node);
                if (lastBR && isFakeLineBreak(lastBR)) {
                    lastBR.after(this.document.createElement("br"));
                }
                // Shrunk blocks are restored by `fillShrunkBlocks`.
            }
        };

        return { restoreFakeBRs, range: { ...range, startOffset, endOffset } };
    }

    fillEmptyInlines(range) {
        const nodes = [range.startContainer];
        if (range.endContainer !== range.startContainer) {
            nodes.push(range.endContainer);
        }
        for (const node of nodes) {
            // @todo: mind Icons?
            // Probably need to get deepest position's element
            // @todo: update fillEmpty
            // @todo: check if nodes does not already have a ZWS/ZWNBSP
            if (!isBlock(node) && !isTangible(node)) {
                node.appendChild(this.document.createTextNode("\u200B"));
                node.setAttribute("data-oe-zws-empty-inline", "");
            }
        }
    }

    fillShrunkBlocks(commonAncestor) {
        const fillBlock = (block) => {
            if (
                block.matches("div[contenteditable='true']") &&
                !block.parentElement.isContentEditable
            ) {
                // @todo: not sure we want this when allowInlineAtRoot is true
                const p = this.document.createElement("p");
                p.appendChild(this.document.createElement("br"));
                block.appendChild(p);
            } else {
                block.appendChild(this.document.createElement("br"));
            }
        };
        // @todo: this ends up filling shrunk blocks outside the affected range.
        // Ideally, it should only affect the block within the boundaries of the
        // original range.
        for (const node of descendants(commonAncestor).reverse()) {
            if (isBlock(node) && isShrunkBlock(node)) {
                fillBlock(node);
            }
        }
        const containingBlock = closestBlock(commonAncestor);
        if (isShrunkBlock(containingBlock)) {
            fillBlock(containingBlock);
        }
    }

    // --------------------------------------------------------------------------
    // Remove nodes
    // --------------------------------------------------------------------------

    removeNodes(range) {
        const { startContainer, startOffset, endContainer, commonAncestorContainer } = range;
        let { endOffset } = range;
        const nodesToRemove = [];

        // Pick child nodes to the right for later removal, propagate until
        // commonAncestorContainer (non-inclusive)
        let node = startContainer;
        let startRemoveIndex = startOffset;
        while (node !== commonAncestorContainer) {
            for (let i = startRemoveIndex; i < node.childNodes.length; i++) {
                nodesToRemove.push(node.childNodes[i]);
            }
            startRemoveIndex = childNodeIndex(node) + 1;
            node = node.parentElement;
        }

        // Pick child nodes to the left for later removal, propagate until
        // commonAncestorContainer (non-inclusive)
        node = endContainer;
        let endRemoveIndex = endOffset;
        while (node !== commonAncestorContainer) {
            for (let i = 0; i < endRemoveIndex; i++) {
                nodesToRemove.push(node.childNodes[i]);
            }
            endRemoveIndex = childNodeIndex(node);
            node = node.parentElement;
        }

        // Pick commonAncestorContainer's direct children for removal
        for (let i = startRemoveIndex; i < endRemoveIndex; i++) {
            nodesToRemove.push(commonAncestorContainer.childNodes[i]);
        }

        // Remove nodes
        let allNodesRemoved = true;
        for (const node of nodesToRemove) {
            const parent = node.parentNode;
            const didRemove = this.removeNode(node);
            allNodesRemoved &&= didRemove;
            if (didRemove && endContainer === parent) {
                endOffset -= 1;
            }
        }

        return { allNodesRemoved, range: { ...range, endOffset } };
    }

    // The root argument is used by some predicates in which a node is
    // conditionally unremovable (e.g. a table cell is only removable if its
    // ancestor table is also being removed).
    isUnremovable(node, root = undefined) {
        // For now, there's no use case of unremovable text nodes.
        // Should this change, the predicates must be adapted to take a Node
        // instead of an Element as argument.
        if (node.nodeType === Node.TEXT_NODE) {
            return false;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return true;
        }
        return this.resources.unremovables.some((predicate) => predicate(node, root));
    }

    // Returns true if the entire subtree rooted at node was removed.
    // Unremovable nodes take the place of removable ancestors.
    removeNode(node) {
        const root = node;
        const remove = (node) => {
            let customHandling = false;
            for (const cb of this.resources["filter_descendants_to_remove"] || []) {
                const descendantsToRemove = cb(node);
                if (descendantsToRemove) {
                    for (const descendant of descendantsToRemove) {
                        remove(descendant);
                    }
                    customHandling = true;
                    node.remove();
                }
            }
            if (customHandling) {
                return true;
            }
            for (const child of [...node.childNodes]) {
                remove(child);
            }
            if (this.isUnremovable(node, root)) {
                return false;
            }
            if (node.hasChildNodes()) {
                node.before(...node.childNodes);
                node.remove();
                return false;
            }
            node.remove();
            return true;
        };
        return remove(node);
    }

    // --------------------------------------------------------------------------
    // Join
    // --------------------------------------------------------------------------

    // Joins both ends of the range if possible: block + block/inline.
    // If joined, the range is collapsed to start.
    // Returns the updated range.
    joinFragments(range) {
        const joinableLeft = this.getJoinableFragment(range, "start");
        const joinableRight = this.getJoinableFragment(range, "end");
        const join = this.getJoinOperation(joinableLeft.type, joinableRight.type);

        const didJoin = join(joinableLeft.node, joinableRight.node, range.commonAncestorContainer);

        return didJoin ? this.collapseRange(range) : range;
    }

    /**
     * Retrieves the joinable fragment based on the given range and side.
     *
     * @param {Object} range - range-like object.
     * @param {"start"|"end"} side
     * @returns {Object} - { node: Node|null, type: "block"|"inline"|"null" }
     */
    getJoinableFragment(range, side) {
        const commonAncestor = range.commonAncestorContainer;
        const container = side === "start" ? range.startContainer : range.endContainer;
        const offset = side === "start" ? range.startOffset : range.endOffset;

        if (container === range.commonAncestorContainer) {
            // This means a direct child of the commonAncestor was removed.
            // The joinable in this case is its sibling (previous for the start
            // side, next for the end side), but only if inline.
            const sibling = childNodes(commonAncestor)[side === "start" ? offset - 1 : offset];
            if (sibling && !isBlock(sibling)) {
                return { node: sibling, type: "inline" };
            }
            // No fragment to join.
            return { node: null, type: "null" };
        }
        // Starting from `container`, find the closest block up to
        // (not-inclusive) the common ancestor. If not found, keep the common
        // ancestor's child inline element.
        let last;
        let element = container;
        while (element !== commonAncestor) {
            if (isBlock(element)) {
                return { node: element, type: "block" };
            }
            last = element;
            element = element.parentElement;
        }
        return { node: last, type: "inline" };
    }

    getJoinOperation(leftType, rightType) {
        return (
            {
                "block + block": this.joinBlocks,
                "block + inline": this.joinInlineIntoBlock,
                "inline + block": this.joinBlockIntoInline,
            }[leftType + " + " + rightType] || (() => true)
        ).bind(this);
        // "inline + inline": Nothing to do, consider it joined.
        // Same any combination involving type "null" (no joinable element).
    }

    isUnmergeable(node) {
        if (this.isUnremovable(node)) {
            return true;
        }
        // @todo @phoenix: get rules as resources
        return isUnbreakable(node);
    }

    joinBlocks(left, right, commonAncestor) {
        // Check if both blocks are mergeable.
        const canMerge = (n) => !findUpTo(n, commonAncestor, this.isUnmergeable.bind(this));
        if (!canMerge(left) || !canMerge(right)) {
            return false;
        }

        left.append(...right.childNodes);
        let toRemove = right;
        let parent = right.parentElement;
        // Propagate until commonAncestor, removing empty blocks
        while (parent !== commonAncestor && parent.childNodes.length === 1) {
            toRemove = parent;
            parent = parent.parentElement;
        }
        toRemove.remove();
        return true;
    }

    joinInlineIntoBlock(leftBlock, rightInline, commonAncestor) {
        if (findUpTo(leftBlock, commonAncestor, (node) => this.isUnmergeable(node))) {
            // Left block is unmergeable.
            return false;
        }

        // @todo: avoid appending a BR as last child of the block
        while (rightInline && !isBlock(rightInline)) {
            const toAppend = rightInline;
            rightInline = rightInline.nextSibling;
            leftBlock.append(toAppend);
        }
        return true;
    }

    joinBlockIntoInline(leftInline, rightBlock, commonAncestor) {
        if (findUpTo(rightBlock, commonAncestor, (node) => this.isUnmergeable(node))) {
            // Right block is unmergeable.
            return false;
        }

        leftInline.after(...childNodes(rightBlock));
        let toRemove = rightBlock;
        let parent = rightBlock.parentElement;
        // Propagate until commonAncestor, removing empty blocks
        while (parent !== commonAncestor && parent.childNodes.length === 1) {
            toRemove = parent;
            parent = parent.parentElement;
        }
        // Restore line break between removed block and inline content after it.
        if (parent === commonAncestor) {
            const rightSibling = toRemove.nextSibling;
            if (rightSibling && !isBlock(rightSibling)) {
                rightSibling.before(this.document.createElement("br"));
            }
        }
        toRemove.remove();
        return true;
    }

    // --------------------------------------------------------------------------
    // Adjust range
    // --------------------------------------------------------------------------

    /**
     * @param {RangeLike}
     * @param {((range: Range) => Range)[]} callbacks
     * @returns {RangeLike}
     */
    adjustRange({ startContainer, startOffset, endContainer, endOffset }, callbacks) {
        let range = this.document.createRange();
        range.setStart(startContainer, startOffset);
        range.setEnd(endContainer, endOffset);

        for (const callback of callbacks) {
            range = callback.call(this, range);
        }

        ({ startContainer, startOffset, endOffset, endContainer } = range);
        return { startContainer, startOffset, endOffset, endContainer };
    }

    /**
     * <h1>[abc</h1><p>d]ef</p> -> [<h1>abc</h1><p>d]ef</p>
     *
     * @param {HTMLElement} block
     * @param {Range} range
     * @returns {Range}
     */
    includeBlockStart(block, range) {
        const { startContainer, startOffset, commonAncestorContainer } = range;
        if (
            block === commonAncestorContainer ||
            !this.isCursorAtStartOfElement(block, startContainer, startOffset)
        ) {
            return range;
        }
        range.setStartBefore(block);
        return this.includeBlockStart(block.parentNode, range);
    }

    /**
     * <p>ab[c</p><div>def]</div> ->  <p>ab[c</p><div>def</div>]
     *
     * @param {HTMLElement} block
     * @param {Range} range
     * @returns {Range}
     */
    includeBlockEnd(block, range) {
        const { endContainer, endOffset, commonAncestorContainer } = range;
        if (
            block === commonAncestorContainer ||
            !this.isCursorAtEndOfElement(block, endContainer, endOffset)
        ) {
            return range;
        }
        range.setEndAfter(block);
        return this.includeBlockEnd(block.parentNode, range);
    }

    /**
     * If range spans two blocks, try to fully include the right (end) one OR
     * the left (start) one (but not both).
     *
     * E.g.:
     * Fully includes the right block:
     * <p>ab[c</p><div>def]</div> ->  <p>ab[c</p><div>def</div>]
     * <p>[abc</p><div>def]</div> ->  <p>[abc</p><div>def</div>]
     *
     * Fully includes the left block:
     * <h1>[abc</h1><p>d]ef</p> -> [<h1>abc</h1><p>d]ef</p>
     *
     * @param {Range} range
     * @returns {Range}
     */
    includeEndOrStartBlock(range) {
        const { startContainer, endContainer, commonAncestorContainer } = range;
        const startBlock = findUpTo(startContainer, commonAncestorContainer, isBlock);
        const endBlock = findUpTo(endContainer, commonAncestorContainer, isBlock);
        if (!startBlock || !endBlock) {
            return range;
        }
        range = this.includeBlockEnd(endBlock, range);
        // Only include start block if end block could not be included.
        if (range.endContainer === endContainer) {
            range = this.includeBlockStart(startBlock, range);
        }
        return range;
    }

    /**
     * Fully select link if:
     * - range spans content inside and outside the link AND
     * - all of its content is selected.
     *
     * <a>[abc</a>d]ef -> [<a>abc</a>d]ef
     * ab[c<a>def]</a> ->  ab[c<a>def</a>]
     * But:
     * <a>[abc]</a> -> <a>[abc]</a> (remains unchanged)
     *
     * @param {Range} range
     * @returns {Range}
     */
    fullyIncludeLinks(range) {
        const { startContainer, startOffset, endContainer, endOffset, commonAncestorContainer } =
            range;
        const [startLink, endLink] = [startContainer, endContainer].map((container) =>
            findUpTo(container, commonAncestorContainer, (node) => node.nodeName === "A")
        );
        if (startLink && this.isCursorAtStartOfElement(startLink, startContainer, startOffset)) {
            range.setStartBefore(startLink);
        }
        if (endLink && this.isCursorAtEndOfElement(endLink, endContainer, endOffset)) {
            range.setEndAfter(endLink);
        }
        return range;
    }

    /**
     * @param {Range} range
     * @returns {Range}
     */
    includeEmptyInlineStart(range) {
        const element = closestElement(range.startContainer);
        if (this.isEmptyInline(element)) {
            range.setStartBefore(element);
        }
        return range;
    }

    /**
     * @param {Range} range
     * @returns {Range}
     */
    includeEmptyInlineEnd(range) {
        const element = closestElement(range.endContainer);
        if (this.isEmptyInline(element)) {
            range.setEndAfter(element);
        }
        return range;
    }

    // @todo @phoenix This is here because of the second test case in
    // delete/forward/selection collapsed/basic/should ignore ZWS, and its
    // importance is questionable.
    /**
     * @param {Range} range
     * @returns {Range}
     */
    includeNextZWS(range) {
        const { endContainer, endOffset } = range;
        if (
            endContainer.nodeType === Node.TEXT_NODE &&
            endContainer.textContent[endOffset] === "\u200B"
        ) {
            range.setEnd(endContainer, endOffset + 1);
        }
        return range;
    }

    /**
     * @param {Range} range
     * @returns {Range}
     */
    includePreviousZWS(range) {
        const { startContainer, startOffset } = range;
        if (
            startContainer.nodeType === Node.TEXT_NODE &&
            startContainer.textContent[startOffset - 1] === "\u200B"
        ) {
            range.setStart(startContainer, startOffset - 1);
        }
        return range;
    }

    // @phoenix @todo: triple click correction is now done by the selection
    // plugin, and this is no longer necessary. Adapt tests that rely on it and
    // remove this method.
    /**
     * @param {Range} range
     * @returns {Range}
     */
    correctTripleClick(range) {
        const { startContainer, startOffset, endContainer, endOffset } = range;
        const endLeaf = firstLeaf(endContainer);
        const beforeEnd = endLeaf.previousSibling;
        if (
            !endOffset &&
            (startContainer !== endContainer || startOffset !== endOffset) &&
            (!beforeEnd ||
                (beforeEnd.nodeType === Node.TEXT_NODE &&
                    !isVisibleTextNode(beforeEnd) &&
                    !isZWS(beforeEnd)))
        ) {
            const previous = previousLeaf(endLeaf, this.editable, true);
            if (previous && closestElement(previous).isContentEditable) {
                range.setEnd(previous, nodeSize(previous));
            }
        }
        return range;
    }

    // Expand the range to fully include all contentEditable=False elements.
    /**
     * @param {Range} range
     * @returns {Range}
     */
    expandRangeToIncludeNonEditables(range) {
        const { startContainer, endContainer, commonAncestorContainer: commonAncestor } = range;
        const startUneditable = getFurthestUneditableParent(startContainer, commonAncestor);
        if (startUneditable) {
            // @todo @phoenix: Review this spec. I suggest this instead (no block merge after removing):
            // startContainer = startUneditable.parentElement;
            // startOffset = childNodeIndex(startUneditable);
            const leaf = previousLeaf(startUneditable);
            if (leaf) {
                range.setStart(leaf, nodeSize(leaf));
            } else {
                range.setStart(commonAncestor, 0);
            }
        }
        const endUneditable = getFurthestUneditableParent(endContainer, commonAncestor);
        if (endUneditable) {
            range.setEndAfter(endUneditable);
        }
        return range;
    }

    // --------------------------------------------------------------------------
    // Find previous/next position
    // --------------------------------------------------------------------------

    // Returns the previous visible position (ex: a previous character, the end
    // of the previous block, etc.).
    findPreviousPosition(node, offset, blockSwitch = false) {
        // Look for a visible character in text node.
        if (node.nodeType === Node.TEXT_NODE) {
            // @todo @phoenix: write tests for chars with size > 1 (emoji, etc.)
            // Use the string iterator to handle surrogate pairs.
            let index = offset;
            const chars = [...node.textContent.slice(0, index)];
            let char = chars.pop();
            while (char) {
                index -= char.length;
                if (this.isVisibleChar(char, node, index)) {
                    return blockSwitch ? [node, index + char.length] : [node, index];
                }
                char = chars.pop();
            }
        }

        // Get previous leaf
        let leaf;
        if (node.hasChildNodes() && offset) {
            leaf = lastLeaf(node.childNodes[offset - 1]);
        } else {
            leaf = previousLeaf(node, this.editable);
        }
        if (!leaf) {
            return [null, null];
        }
        // Skip invisible leafs, keeping track whether a block switch occurred.
        const endNodeClosestBlock = closestBlock(node);
        blockSwitch ||= closestBlock(leaf) !== endNodeClosestBlock;
        while (this.shouldSkip(leaf, blockSwitch)) {
            leaf = previousLeaf(leaf, this.editable);
            if (!leaf) {
                return [null, null];
            }
            blockSwitch ||= closestBlock(leaf) !== endNodeClosestBlock;
        }

        // If part of a contenteditable=false tree, expand selection to delete the root.
        // If the non-editable is not a block and there was a block switch, reduce the
        // selection to keep it instead, since the position moved from another block next
        // to that inline root, there was a sufficient position change.
        let closestUneditable = closestElement(leaf, isNotEditableNode);
        if (closestUneditable) {
            // handle nested contenteditable=false elements
            while (!closestUneditable.parentNode.isContentEditable) {
                closestUneditable = closestUneditable.parentNode;
            }
            return blockSwitch &&
                !isBlock(closestUneditable) &&
                closestBlock(closestUneditable) !== endNodeClosestBlock
                ? rightPos(closestUneditable)
                : leftPos(closestUneditable);
        }

        if (leaf.nodeType === Node.ELEMENT_NODE) {
            return blockSwitch ? rightPos(leaf) : leftPos(leaf);
        }

        return this.findPreviousPosition(leaf, nodeSize(leaf), blockSwitch);
    }

    findNextPosition(node, offset, blockSwitch = false) {
        // Look for a visible character in text node.
        if (node.nodeType === Node.TEXT_NODE) {
            // Use the string iterator to handle surrogate pairs.
            let index = offset;
            for (const char of node.textContent.slice(index)) {
                if (this.isVisibleChar(char, node, index)) {
                    index += blockSwitch ? 0 : char.length;
                    return [node, index];
                }
                index += char.length;
            }
        }

        // Get next leaf
        let leaf;
        if (node.hasChildNodes() && offset < nodeSize(node)) {
            leaf = firstLeaf(node.childNodes[offset]);
        } else {
            leaf = nextLeaf(node, this.editable);
        }
        if (!leaf) {
            return [null, null];
        }
        // Skip invisible leafs, keeping track whether a block switch occurred.
        const startNodeClosestBlock = closestBlock(node);
        blockSwitch ||= closestBlock(leaf) !== startNodeClosestBlock;
        while (this.shouldSkip(leaf, blockSwitch)) {
            leaf = nextLeaf(leaf, this.editable);
            if (!leaf) {
                return [null, null];
            }
            blockSwitch ||= closestBlock(leaf) !== startNodeClosestBlock;
        }

        // If part of a contenteditable=false tree, expand selection to delete the root.
        // If the non-editable is not a block and there was a block switch, reduce the
        // selection to keep it instead, since the position moved from another block to
        // that inline root, there was a sufficient position change.
        let closestUneditable = closestElement(leaf, isNotEditableNode);
        if (closestUneditable) {
            // handle nested contenteditable=false elements
            while (!closestUneditable.parentNode.isContentEditable) {
                closestUneditable = closestUneditable.parentNode;
            }
            return blockSwitch &&
                !isBlock(closestUneditable) &&
                closestBlock(closestUneditable) !== startNodeClosestBlock
                ? leftPos(closestUneditable)
                : rightPos(closestUneditable);
        }

        if (leaf.nodeType === Node.ELEMENT_NODE) {
            return blockSwitch ? leftPos(leaf) : rightPos(leaf);
        }

        return this.findNextPosition(leaf, 0, blockSwitch);
    }

    findPreviousLineBoundary(endContainer, endOffset) {
        const block = closestBlock(endContainer);
        let last = endContainer;
        let node = previousLeaf(endContainer, this.editable);
        // look for a BR or a block start
        while (node && node.nodeName !== "BR" && closestBlock(node) === block) {
            last = node;
            node = previousLeaf(node, this.editable);
        }
        if (last === endContainer && endOffset === 0) {
            // Cursor is already next to the line break, go to previous position.
            return this.findPreviousPosition(endContainer, endOffset);
        }
        return leftPos(last);
    }

    findNextLineBoundary(startContainer, startOffset) {
        const block = closestBlock(startContainer);
        let last = startContainer;
        let node = nextLeaf(startContainer, this.editable);
        // look for a BR or a block start
        while (node && node.nodeName !== "BR" && closestBlock(node) === block) {
            last = node;
            node = nextLeaf(node, this.editable);
        }
        if (last === startContainer && startOffset === nodeSize(startContainer)) {
            // Cursor is already next to the line break, go to next position.
            return this.findNextPosition(startContainer, startOffset);
        }
        return rightPos(last);
    }

    // @todo @phoenix: there are not enough tests for visibility of characters
    // (invisible whitespace, separate nodes, etc.)
    isVisibleChar(char, textNode, offset) {
        // ZWS and ZWNBSP are invisible.
        if (["\u200B", "\uFEFF"].includes(char)) {
            return false;
        }
        if (!isWhitespace(char) || isInPre(textNode)) {
            return true;
        }

        // Assess visibility of whitespace.
        // Whitespace is visible if it's immediately preceded by content, and
        // followed by content before a BR or block start/end.

        // If not preceded by content, it is invisible.
        if (offset) {
            if (isWhitespace(textNode.textContent[offset - char.length])) {
                return false;
            }
        } else if (!(getState(...leftPos(textNode), DIRECTIONS.LEFT).cType & CTYPES.CONTENT)) {
            return false;
        }

        // Space is only visible if it's followed by content (with an optional
        // sequence of invisible spaces in between), before a BR or block
        // end/start.
        const charsToTheRight = textNode.textContent.slice(offset + char.length);
        for (char of charsToTheRight) {
            if (!isWhitespace(char)) {
                return true;
            }
        }
        // No content found in text node, look to the right of it
        if (getState(...rightPos(textNode), DIRECTIONS.RIGHT).cType & CTYPES.CONTENT) {
            return true;
        }

        return false;
    }

    shouldSkip(leaf, blockSwitch) {
        if (leaf.nodeType === Node.TEXT_NODE) {
            return false;
        }
        // @todo Maybe skip anything that is not an element (e.g. comment nodes)
        if (blockSwitch) {
            return false;
        }
        if (leaf.nodeName === "BR" && isFakeLineBreak(leaf)) {
            return true;
        }
        if (isSelfClosingElement(leaf)) {
            return false;
        }
        if (isEmpty(leaf) || isZWS(leaf)) {
            return true;
        }
        return false;
    }

    // --------------------------------------------------------------------------
    // Event handlers
    // --------------------------------------------------------------------------

    onBeforeInput(e) {
        const command = beforeInputHandlers[e.inputType];
        if (command) {
            e.preventDefault();
            this.dispatch(command);
        }
    }
    /**
     * @param {KeyboardEvent} ev
     */
    onKeydown(ev) {
        // If the pressed key has a printed representation, the returned value
        // is a non-empty Unicode character string containing the printable
        // representation of the key. In this case, call `deleteRange` before
        // inserting the printed representation of the character.
        if (/^.$/u.test(ev.key) && !ev.ctrlKey && !ev.metaKey && (isMacOS() || !ev.altKey)) {
            const selection = this.shared.getEditableSelection();
            if (selection && !selection.isCollapsed) {
                this.deleteSelection(selection);
            }
        }
    }

    // ======== AD-HOC STUFF ========

    deleteBackwardUnmergeable(range) {
        const { startContainer, startOffset, endContainer, endOffset } = range;
        return this.deleteCharUnmergeable(endContainer, endOffset, startContainer, startOffset);
    }

    // @todo @phoenix: write tests for this
    deleteForwardUnmergeable(range) {
        const { startContainer, startOffset, endContainer, endOffset } = range;
        return this.deleteCharUnmergeable(startContainer, startOffset, endContainer, endOffset);
    }

    // Trap cursor inside unmergeable element. Remove it if empty.
    deleteCharUnmergeable(sourceContainer, sourceOffset, destContainer, destOffset) {
        if (!destContainer) {
            return;
        }
        const commonAncestor = getCommonAncestor([sourceContainer, destContainer], this.editable);
        const closestUnmergeable = findUpTo(sourceContainer, commonAncestor, (node) =>
            this.isUnmergeable(node)
        );
        if (!closestUnmergeable) {
            return;
        }

        if (isEmpty(closestUnmergeable) && !this.isUnremovable(closestUnmergeable)) {
            closestUnmergeable.remove();
            this.shared.setSelection({ anchorNode: destContainer, anchorOffset: destOffset });
        } else {
            this.shared.setSelection({ anchorNode: sourceContainer, anchorOffset: sourceOffset });
        }
        return true;
    }

    // --------------------------------------------------------------------------
    // utils
    // --------------------------------------------------------------------------

    isEmptyInline(element) {
        if (isBlock(element)) {
            return false;
        }
        if (isZWS(element)) {
            return true;
        }
        return element.innerHTML.trim() === "";
    }

    isCursorAtStartOfElement(element, cursorNode, cursorOffset) {
        const [node] = this.findPreviousPosition(cursorNode, cursorOffset);
        return !element.contains(node);
    }

    isCursorAtEndOfElement(element, cursorNode, cursorOffset) {
        const [node] = this.findNextPosition(cursorNode, cursorOffset);
        return !element.contains(node);
    }

    /**
     * @param {RangeLike} range
     */
    setCursorFromRange(range, { collapseToEnd = false } = {}) {
        range = this.collapseRange(range, { toEnd: collapseToEnd });
        const [anchorNode, anchorOffset] = this.normalizeEnterBlock(
            range.startContainer,
            range.startOffset
        );
        this.shared.setSelection({ anchorNode, anchorOffset });
    }

    // @todo: no need for this once selection in the editable root is corrected?
    normalizeEnterBlock(node, offset) {
        while (isBlock(node.childNodes[offset])) {
            [node, offset] = [node.childNodes[offset], 0];
        }
        return [node, offset];
    }

    /**
     * @param {RangeLike} range
     */
    collapseRange(range, { toEnd = false } = {}) {
        let { startContainer, startOffset, endContainer, endOffset } = range;
        if (toEnd) {
            [startContainer, startOffset] = [endContainer, endOffset];
        } else {
            [endContainer, endOffset] = [startContainer, startOffset];
        }
        const commonAncestorContainer = startContainer;
        return { startContainer, startOffset, endContainer, endOffset, commonAncestorContainer };
    }
}
