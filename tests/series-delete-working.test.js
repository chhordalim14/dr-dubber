// Dub Whole Series' "Delete working files when done" (backend/routes/episodes.js): only the joined
// parts and split tabs the app made, straight inside "DR Dubber Joined" / "DR Dubber Split" -
// never an episode, a dubbed export or anything a path trick points at.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createEpisodesRouter = require('../backend/routes/episodes');
const { isWorkingFile } = createEpisodesRouter;

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
