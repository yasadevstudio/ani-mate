// YASA PRESENTS
/* ani-mate-notes.js: a release's notes as a person reads them.
 *
 * The notes are written for the release page, where "## Heading", "**bold**" and "- item"
 * are drawn as a heading, bold type and a list. The update box shows them as plain text,
 * because they arrive over the network and are never put into the page as markup, and
 * plain text showed the marks as typed: "## The right subtitles" (seen on a phone,
 * 2026-11-14). plain() takes the marks off and leaves the words.
 *
 *     ## Heading          ->  Heading
 *     - item, * item      ->  • item
 *     **bold**, *slanted* ->  bold, slanted
 *     `code`              ->  code
 *     [words](address)    ->  words
 *     ---                 ->  (nothing)
 *
 * ⛔ IT RETURNS A STRING AND MAKES NO ELEMENTS. Whatever else is in the notes, HTML
 * included, comes out as the characters that were typed. The caller writes the result
 * with textContent.
 *
 * The text is then cut to `limit` characters where a thought ends: the end of a sentence
 * or of a line. Only when neither is in reach is it cut between two words, and then it
 * says so with "…". It used to stop at character 300, mid-sentence. A heading left with
 * nothing under it is taken off the end.
 *
 * The phone's page loads this as a script; tests/notes.test.js loads it in Node.
 */
(function (root) {
    'use strict';

    const RULED = /^\s*([-*_=])(\s*\1){2,}\s*$/;        // ---  ***  ___  ===
    const FENCE = /^\s*(```|~~~)/;
    const HEADING = /^\s{0,3}#{1,6}\s+(?=\S)/;

    /* One line, with the marks a release page would have drawn taken off. */
    function unmark(line) {
        return line
            .replace(HEADING, '')                                                  // ## Heading
            .replace(/^\s{0,3}>\s?/, '')                                           // > quoted
            .replace(/^(\s*)[-*+]\s+(?:\[[ xX]\]\s+)?/, '$1• ')               // - item   * item   - [x] item
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                              // ![picture](address)
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                               // [words](address)
            .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '$1')                              // **bold**
            .replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1$2')   // *slanted*
            .replace(/(^|\W)__(\S(?:.*?\S)?)__(?!\w)/g, '$1$2')                    // __bold__
            .replace(/(^|\W)_([^\s_](?:[^_]*[^\s_])?)_(?!\w)/g, '$1$2')            // _slanted_
            .replace(/`([^`]+)`/g, '$1');                                          // `code`
    }

    /* Where the text may stop: after the last sentence or line that ends inside `max`
     * characters, as long as that keeps at least two fifths of what fits. */
    function cut(text, max) {
        const floor = Math.floor(max * 0.4);
        const probe = text.slice(0, max + 1);
        const ends = /[.!?]["')\]”]?(?=\s)|\n/g;
        let end = -1;
        let m;
        while ((m = ends.exec(probe))) {
            const at = m[0] === '\n' ? m.index : m.index + m[0].length;
            if (at <= max) end = at;
        }
        if (end >= floor) return text.slice(0, end).replace(/\s+$/, '');
        /* No thought ends in reach: between two words, and say so. The mark is one of
         * the characters that fit. */
        const head = text.slice(0, Math.max(1, max - 1));
        const space = head.search(/\s\S*$/);
        return (space >= floor ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '') + '…';
    }

    function plain(markdown, limit) {
        const lines = [];                   // { text, head }
        let fenced = false;
        for (const raw of String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n')) {
            if (FENCE.test(raw)) { fenced = !fenced; continue; }      // the fence says nothing itself
            let text;
            let head = false;
            if (fenced) text = raw.replace(/\s+$/, '');               // what is inside one is left as typed
            else {
                if (RULED.test(raw)) continue;
                head = HEADING.test(raw);
                text = unmark(raw).replace(/\s+$/, '');
            }
            /* One blank line between things, none at the top. */
            if (!text && (!lines.length || !lines[lines.length - 1].text)) continue;
            lines.push({ text, head });
        }
        while (lines.length && !lines[lines.length - 1].text) lines.pop();

        const whole = lines.map((l) => l.text).join('\n');
        const max = Number(limit) > 0 ? Math.floor(Number(limit)) : 0;
        if (!max || whole.length <= max) return whole;

        const kept = cut(whole, max).split('\n');
        /* A heading with nothing under it says nothing. */
        while (kept.length > 1) {
            const i = kept.length - 1;
            if (kept[i] === '' || (lines[i].head && kept[i] === lines[i].text)) kept.pop();
            else break;
        }
        return kept.join('\n');
    }

    const api = { plain };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AniMateNotes = api;
})(typeof window !== 'undefined' ? window : globalThis);
