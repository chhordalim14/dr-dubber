// Dub Whole Series' "Delete working files when done" (backend/routes/episodes.js): only the joined
// parts and split tabs the app made, straight inside "DR Dubber Joined" / "DR Dubber Split" -
// never an episode, a dubbed export or anything a path trick points at.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createEpisodesRouter = require('../backend/routes/episodes');
const { isWorkingFile, isPartExportFile } = createEpisodesRouter;

describe('deleting the series\' working files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-working-'));
  const joined = path.join(root, 'Show', 'DR Dubber Joined');
  const split = path.join(joined, 'DR Dubber Split');
  fs.mkdirSync(split, { recursive: true });
  const make = (p) => { fs.writeFileSync(p, 'x'.repeat(1000)); return p; };
  const part = make(path.join(joined, 'Show_part01.mp4'));
  const list = make(path.join(joined, 'Show_part01_episodes.txt'));
  const piece = make(path.join(split, 'Show_part01_part01.mp4'));
  const episode = make(path.join(root, 'Show', 'E01.mp4'));
  const exported = make(path.join(root, 'Show_Dubbed_E01_Khmer_Dubbed.mp4'));
  const program = make(path.join(joined, 'tool.exe'));

  test('only media and lists straight inside the app\'s working folders count', () => {
    assert.equal(isWorkingFile(part), true);
    assert.equal(isWorkingFile(list), true);
    assert.equal(isWorkingFile(piece), true);
    assert.equal(isWorkingFile(episode), false, 'an episode');
    assert.equal(isWorkingFile(exported), false, 'a dubbed export');
    assert.equal(isWorkingFile(program), false, 'not a media file');
    assert.equal(isWorkingFile(`${joined}${path.sep}..${path.sep}E01.mp4`), false, 'a ".." path');
    assert.equal(isWorkingFile('relative/DR Dubber Joined/a.mp4'), false);
    assert.equal(isWorkingFile('\\\\server\\share\\DR Dubber Joined\\a.mp4'), false, 'a network path');
    assert.equal(isWorkingFile(42), false);
  });

  test('the route deletes the working files, refuses the rest, and says how much it freed', () => {
    const router = createEpisodesRouter({ episodeJoiner: {} });
    const handler = router.stack.find((l) => l.route && l.route.path === '/delete-working').route.stack[0].handle;
    let out = null;
    handler({ body: { paths: [part, list, piece, episode, exported, program] } }, { json: (d) => { out = d; } });
    assert.deepEqual(out, { success: true, deleted: 3, freed: 3000, refused: 3 });
    assert.ok(!fs.existsSync(part) && !fs.existsSync(list) && !fs.existsSync(piece));
    assert.ok(fs.existsSync(episode) && fs.existsSync(exported) && fs.existsSync(program), 'everything else stays');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('deleting individual part exports after joining the full series', () => {
  test('deletes only sibling part videos next to an existing full video, never the full video or other folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-fullkeep-'));
    const outDir = path.join(root, 'Show_Dubbed');
    const otherDir = path.join(root, 'Originals');
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    const make = (p, bytes = 1000) => { fs.writeFileSync(p, 'x'.repeat(bytes)); return p; };
    const full = make(path.join(outDir, 'Show_Dubbed_full.mp4'), 5000);
    const p1 = make(path.join(outDir, 'Show_part01_Khmer_Dubbed.mp4'), 1200);
    const p2 = make(path.join(outDir, 'Show_part02_Khmer_Dubbed.mp4'), 1300);
    const orig = make(path.join(otherDir, 'E01.mp4'), 1000);
    const notes = make(path.join(outDir, 'notes.txt'), 100);

    assert.equal(isPartExportFile(p1, full), true);
    assert.equal(isPartExportFile(full, full), false, 'never delete keepFile itself');
    assert.equal(isPartExportFile(orig, full), false, 'never delete outside the export folder');
    assert.equal(isPartExportFile(notes, full), false, 'never delete non-video files');
    assert.equal(isPartExportFile(`${outDir}${path.sep}..${path.sep}Originals${path.sep}E01.mp4`, full), false);

    const router = createEpisodesRouter({ episodeJoiner: {} });
    const handler = router.stack.find((l) => l.route && l.route.path === '/delete-part-exports').route.stack[0].handle;

    // Missing or empty keepFile refuses everything.
    let missingOut = null;
    handler({ body: { paths: [p1], keepFile: path.join(outDir, 'Missing_full.mp4') } }, { json: (d) => { missingOut = d; } });
    assert.equal(missingOut.success, false);
    assert.ok(fs.existsSync(p1), 'parts stay untouched when full file is missing');

    // Existing full video allows sibling part deletion, keeps full + other folders + non-videos.
    let okOut = null;
    handler({ body: { paths: [p1, p2, full, orig, notes], keepFile: full } }, { json: (d) => { okOut = d; } });
    assert.deepEqual(okOut, { success: true, deleted: 2, freed: 2500, refused: 3 });
    assert.ok(!fs.existsSync(p1) && !fs.existsSync(p2));
    assert.ok(fs.existsSync(full) && fs.existsSync(orig) && fs.existsSync(notes));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
