import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  compileProject,
  escapeInlineJsonPayload,
} from '../vps-server/studio/compile-project.js';

const TEMPLATE = `<!DOCTYPE html>
<html lang="id">
<head><meta charset="utf-8"><title>Test</title></head>
<body>
<canvas id="stage"></canvas>
<script>
const dataNode = document.getElementById('motion-project-data');
const PROJECT = dataNode ? JSON.parse(dataNode.textContent) : null;
window.renderFrame = function renderFrame() {};
</script>
</body>
</html>`;

function project(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: 'prj_11111111-1111-4111-8111-111111111111',
    title: 'Promo Kopi',
    template: 'base',
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264' },
    theme: {
      backgroundColor: '#070913',
      primaryColor: '#38bdf8',
      accentColor: '#a855f7',
      fontFamily: 'Inter',
    },
    scenes: [{
      id: 'scn_22222222-2222-4222-8222-222222222222',
      durationSec: 10,
      transition: { type: 'fade', durationSec: 0.5 },
      elements: [{
        id: 'el_33333333-3333-4333-8333-333333333333',
        type: 'text',
        role: 'title',
        text: 'Kopi Nusantara',
        x: 0.08,
        y: 0.42,
        width: 0.84,
        fontSize: 96,
        color: '#f1f5f9',
        align: 'left',
      }],
    }],
    ...overrides,
  };
}

function imageProject(assetId = 'ast_55555555-5555-4555-8555-555555555555') {
  const value = project();
  value.scenes[0].elements.push({
    id: 'el_44444444-4444-4444-8444-444444444444',
    type: 'image',
    role: 'background',
    assetId,
    fit: 'cover',
    kenBurns: true,
  });
  return value;
}

const AUDIO_ASSET_ID = 'ast_66666666-6666-4666-8666-666666666666';

function audioProject(assetId = AUDIO_ASSET_ID) {
  return project({ audio: { assetId } });
}

function readTemplate() {
  return Promise.resolve(TEMPLATE);
}

function extractPayload(html) {
  const match = html.match(
    /<script id="motion-project-data" type="application\/json">([\s\S]*?)<\/script>/
  );
  assert.ok(match, 'project data script is missing');
  return JSON.parse(match[1]);
}

test('inline JSON escapes script breakouts and preserves original text', () => {
  const text = '</script><img src=x onerror=alert(1)>  &';
  const escaped = escapeInlineJsonPayload({ text });

  assert.ok(!escaped.includes('</script>'));
  assert.ok(!escaped.includes('<img'));
  assert.ok(!escaped.includes('&'));
  assert.ok(!escaped.includes(' '));
  assert.ok(!escaped.includes(' '));
  assert.deepEqual(JSON.parse(escaped), { text });
});

test('inline JSON neutralizes sanitizer tokens without changing parsed data', () => {
  const text = 'fetch( process.env WebSocket( javascript: file:///etc/passwd';
  const escaped = escapeInlineJsonPayload({ text });

  assert.ok(!/\bfetch\s*\(/i.test(escaped));
  assert.ok(!/\bprocess\.env\b/i.test(escaped));
  assert.ok(!/\bWebSocket\s*\(/i.test(escaped));
  assert.ok(!/javascript:/i.test(escaped));
  assert.ok(!/file:\/\/\/(?:etc|proc|sys)\//i.test(escaped));
  assert.deepEqual(JSON.parse(escaped), { text });
});

test('deterministic compilation injects one inert project data script', async () => {
  const first = await compileProject(project(), { target: 'render', readTemplate });
  const second = await compileProject(project(), { target: 'render', readTemplate });

  assert.equal(first.html, second.html);
  assert.equal((first.html.match(/id="motion-project-data"/g) || []).length, 1);
  assert.match(first.html, /type="application\/json"/);
  assert.equal(extractPayload(first.html).scenes[0].elements[0].text, 'Kopi Nusantara');
  assert.equal(first.project.template, 'base');
});

test('user text stays inert while surviving compilation unchanged', async () => {
  const dangerousText = '</script><img src="https://evil.example/x" onerror="alert(1)"> fetch(';
  const value = project();
  value.scenes[0].elements[0].text = dangerousText;

  const result = await compileProject(value, { target: 'render', readTemplate });

  assert.ok(!result.html.includes('<img src="https://evil.example/x"'));
  assert.equal(extractPayload(result.html).scenes[0].elements[0].text, dangerousText);
});

test('preview maps assets to authenticated same-origin content routes', async () => {
  const seen = [];
  const result = await compileProject(imageProject(), {
    target: 'preview',
    readTemplate,
    resolveAsset: async (assetId, context) => {
      seen.push({ assetId, context });
      return { localPath: 'must-not-leak' };
    },
  });

  const element = extractPayload(result.html).scenes[0].elements[1];
  assert.equal(element.src, '/api/studio/assets/ast_55555555-5555-4555-8555-555555555555/content');
  assert.ok(!result.html.includes('file://'));
  assert.ok(!result.html.includes('must-not-leak'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].context.target, 'preview');
});

test('preview uses a supplied signed asset URL and injects the postMessage bridge', async () => {
  const result = await compileProject(imageProject(), {
    target: 'preview',
    readTemplate,
    resolveAsset: async () => ({ localPath: 'must-not-leak' }),
    buildPreviewUrl: (assetId) => `/signed/${assetId}`,
  });

  const element = extractPayload(result.html).scenes[0].elements[1];
  assert.equal(element.src, '/signed/ast_55555555-5555-4555-8555-555555555555');
  assert.ok(result.html.includes('motion-preview-bridge'));
  assert.ok(result.html.includes('motion-preview-frame'));
});

test('render target never injects the preview postMessage bridge', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-compile-bridge-'));
  const previous = process.env.RENDER_ALLOWED_FILE_DIRS;
  process.env.RENDER_ALLOWED_FILE_DIRS = rootDir;
  try {
    const result = await compileProject(imageProject(), {
      target: 'render',
      readTemplate,
      resolveAsset: async () => ({ localPath: path.join(rootDir, 'asset.jpg') }),
    });
    assert.ok(!result.html.includes('motion-preview-bridge'));
    assert.ok(!result.html.includes('motion-preview-frame'));
  } finally {
    process.env.RENDER_ALLOWED_FILE_DIRS = previous;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('render maps assets only through the server resolver to trusted file URLs', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-compile-assets-'));
  const previous = process.env.RENDER_ALLOWED_FILE_DIRS;
  process.env.RENDER_ALLOWED_FILE_DIRS = rootDir;
  try {
    const localPath = path.join(rootDir, 'asset.jpg');
    const result = await compileProject(imageProject(), {
      target: 'render',
      readTemplate,
      resolveAsset: async () => ({ localPath }),
    });

    const element = extractPayload(result.html).scenes[0].elements[1];
    assert.match(element.src, /^file:\/\//);
    assert.ok(!result.html.includes('/api/studio/assets/'));
    assert.ok(result.html.includes('asset.jpg'));
  } finally {
    if (previous === undefined) delete process.env.RENDER_ALLOWED_FILE_DIRS;
    else process.env.RENDER_ALLOWED_FILE_DIRS = previous;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('render resolves project audio outside browser-safe project data', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motion-compile-audio-'));
  const audioLocalPath = path.join(rootDir, 'track.mp3');
  try {
    const result = await compileProject(audioProject(), {
      target: 'render',
      readTemplate,
      resolveAsset: async (assetId, context) => {
        assert.equal(assetId, AUDIO_ASSET_ID);
        assert.deepEqual(context, { target: 'render', role: 'audio' });
        return { localPath: audioLocalPath };
      },
    });

    assert.equal(result.audioLocalPath, audioLocalPath);
    assert.deepEqual(result.project.audio, { assetId: AUDIO_ASSET_ID });
    assert.deepEqual(extractPayload(result.html).audio, { assetId: AUDIO_ASSET_ID });
    assert.ok(!result.html.includes(audioLocalPath));
    assert.ok(!result.html.includes('track.mp3'));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('preview validates project audio ownership without exposing a local path', async () => {
  const seen = [];
  const result = await compileProject(audioProject(), {
    target: 'preview',
    readTemplate,
    resolveAsset: async (assetId, context) => {
      seen.push({ assetId, context });
      return { localPath: 'must-not-leak' };
    },
  });

  assert.deepEqual(seen, [{
    assetId: AUDIO_ASSET_ID,
    context: { target: 'preview', role: 'audio' },
  }]);
  assert.equal(result.audioLocalPath, undefined);
  assert.deepEqual(extractPayload(result.html).audio, { assetId: AUDIO_ASSET_ID });
  assert.ok(!result.html.includes('must-not-leak'));
});

test('audio projects require a resolver for render', async () => {
  await assert.rejects(
    () => compileProject(audioProject(), { target: 'render', readTemplate }),
    /resolver|aset|audio/i
  );
});

test('asset projects require a resolver and reject malformed resolver results', async () => {
  await assert.rejects(
    () => compileProject(imageProject(), { target: 'render', readTemplate }),
    /resolver|aset|asset/i
  );
  await assert.rejects(
    () => compileProject(imageProject(), {
      target: 'render',
      readTemplate,
      resolveAsset: async () => ({ localPath: '' }),
    }),
    /path|aset|asset/i
  );
});

test('unsupported compile targets are rejected', async () => {
  await assert.rejects(
    () => compileProject(project(), { target: 'download', readTemplate }),
    /target/i
  );
});

test('missing templates and invalid template HTML fail safely', async () => {
  await assert.rejects(
    () => compileProject(project(), { target: 'render', readTemplate: async () => '' }),
    /HTML|template/i
  );
  await assert.rejects(
    () => compileProject(project(), {
      target: 'render',
      readTemplate: async () => '<html><body><script>fetch("https://evil.example")</script></body></html>',
    }),
    /Security policy violation/i
  );
});

test('optional AI HTML replaces deterministic output only after validation', async () => {
  const calls = [];
  const result = await compileProject(project(), {
    target: 'render',
    readTemplate,
    useAiHtml: true,
    generateAiHtml: async (input) => {
      calls.push(input);
      return `<!DOCTYPE html><html><body><canvas></canvas><script>
        window.renderFrame = function renderFrame() {};
      </script></body></html>`;
    },
    testAiHtml: async (html, spec) => {
      calls.push({ html, spec });
      return { success: true, errors: [] };
    },
  });

  assert.match(result.html, /motion-project-data/);
  assert.match(result.html, /window\.renderFrame/);
  assert.ok(!result.html.includes('<title>Test</title>'));
  assert.deepEqual(result.warnings, []);
  assert.equal(calls[0].scenes[0].elements[0].src, undefined);
});

test('optional AI HTML failure falls back to deterministic output with warning', async () => {
  const deterministic = await compileProject(project(), { target: 'render', readTemplate });
  const result = await compileProject(project(), {
    target: 'render',
    readTemplate,
    useAiHtml: true,
    generateAiHtml: async () => '<html><body><script>fetch("https://evil.example")</script></body></html>',
    testAiHtml: async () => {
      throw new Error('test must not run after sanitizer failure');
    },
  });

  assert.equal(result.html, deterministic.html);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /AI|deterministik|fallback/i);
});

test('AI HTML that fails dry-run falls back without failing compilation', async () => {
  const result = await compileProject(project(), {
    target: 'render',
    readTemplate,
    useAiHtml: true,
    generateAiHtml: async () => '<html><body><script>window.renderFrame=function(){};</script></body></html>',
    testAiHtml: async () => ({ success: false, errors: ['blank output'] }),
  });

  assert.match(result.html, /<title>Test<\/title>/);
  assert.match(result.warnings[0], /blank output/);
});

test('render limits are enforced before template loading', async () => {
  let templateReads = 0;
  const invalid = project({
    // Duration now derives from the timeline, so the scene must exceed the limit.
    render: { duration: 10, fps: 30, width: 1280, height: 720, codec: 'h264' },
  });
  invalid.scenes[0].durationSec = 61;

  await assert.rejects(
    () => compileProject(invalid, {
      target: 'render',
      readTemplate: async () => {
        templateReads += 1;
        return TEMPLATE;
      },
    }),
    /durasi scene/i
  );
  assert.equal(templateReads, 0);
});
