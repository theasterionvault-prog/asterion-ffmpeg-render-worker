import express from 'express';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const RENDER_TOKEN = process.env.RENDER_TOKEN || '';
const WORK_DIR = process.env.WORK_DIR || '/tmp/asterion-renders';

app.use(express.json({ limit: '25mb' }));
app.use('/files', express.static(WORK_DIR));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'asterion-ffmpeg-render-worker' });
});

app.post('/render', async (req, res) => {
  try {
        console.log('Render request received');
    console.log(JSON.stringify({
      project_id: req.body?.project_id || '',
      format: req.body?.format || '',
      selected_assets_count: Array.isArray(req.body?.selected_assets)
        ? req.body.selected_assets.length
        : 'not_array',
      scenes_count: Array.isArray(req.body?.scenes)
        ? req.body.scenes.length
        : 'not_array',
      has_voice_url: !!(
        req.body?.voice_url ||
        req.body?.voice_file_url ||
        req.body?.voice_public_url
      ),
      has_music_url: !!(
        req.body?.music_url ||
        req.body?.music_file_url
      )
    }));
    
    if (RENDER_TOKEN && req.header('x-render-token') !== RENDER_TOKEN) {
      return res.status(401).json({ status: 'failed', error: 'Unauthorized' });
    }

    const job = req.body || {};
    const projectId = safeName(job.project_id || 'project');
    const renderId = safeName(job.render_id || crypto.randomUUID());
    const scenes = normalizeScenes(job);

    if (!scenes.length) {
      return res.status(400).json({ status: 'failed', error: 'No scenes supplied' });
    }

    const width = Number(job.width || (job.format === 'short' ? 1080 : 1920));
    const height = Number(job.height || (job.format === 'short' ? 1920 : 1080));
    const fps = Number(job.fps || 30);

    const jobDir = path.join(WORK_DIR, `${projectId}-${renderId}`);
    await fs.mkdir(jobDir, { recursive: true });

    const segmentFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const assetUrl = scene.asset_url || scene.url || scene.video_url || scene.image_url || scene.preview;

      if (!assetUrl) continue;

      const assetPath = path.join(jobDir, `asset-${i}${extensionFromUrl(assetUrl)}`);
      const segmentPath = path.join(jobDir, `segment-${i}.mp4`);

      await download(assetUrl, assetPath);
      await renderSegment(assetPath, segmentPath, {
        duration: Number(scene.duration || 5),
        width,
        height,
        fps
      });

      segmentFiles.push(segmentPath);
    }

    if (!segmentFiles.length) {
      return res.status(400).json({ status: 'failed', error: 'No usable assets downloaded' });
    }

    const concatFile = path.join(jobDir, 'concat.txt');
    await fs.writeFile(
      concatFile,
      segmentFiles.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n')
    );

    const silentVideo = path.join(jobDir, 'video-only.mp4');

    await run('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      silentVideo
    ]);

    const voiceUrl = job.voice_url || job.voice_file_url || job.voice_public_url;
    const musicUrl = job.music_url || job.music_file_url || '';

    const outputName = safeName(
      job.output_name || `${projectId}_${job.format === 'short' ? 'short' : 'long'}_video`
    ) + '.mp4';

    const outputPath = path.join(WORK_DIR, outputName);

    if (voiceUrl) {
      const voicePath = path.join(jobDir, `voice${extensionFromUrl(voiceUrl, '.mp3')}`);
      await download(voiceUrl, voicePath);

      if (musicUrl) {
        const musicPath = path.join(jobDir, `music${extensionFromUrl(musicUrl, '.mp3')}`);
        await download(musicUrl, musicPath);

        await run('ffmpeg', [
          '-y',
          '-i', silentVideo,
          '-i', voicePath,
          '-i', musicPath,
          '-filter_complex',
          '[1:a]volume=1.0[narration];[2:a]volume=0.12[music];[narration][music]amix=inputs=2:duration=first[aout]',
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          outputPath
        ]);
      } else {
        await run('ffmpeg', [
          '-y',
          '-i', silentVideo,
          '-i', voicePath,
          '-map', '0:v',
          '-map', '1:a',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          outputPath
        ]);
      }
    } else {
      await fs.copyFile(silentVideo, outputPath);
    }

    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const renderUrl = `${base}/files/${encodeURIComponent(outputName)}`;

    res.json({
      status: 'complete',
      project_id: job.project_id || '',
      render_id: renderId,
      file: outputName,
      render_url: renderUrl,
      long_video_public_url: job.format === 'short' ? '' : renderUrl,
      public_url: renderUrl
    });
    } catch (error) {
    console.error('Render failed:', error);
    res.status(500).json({
      status: 'failed',
      error: error.message || String(error)
    });
  }
});
app.post('/stitch', async (req, res) => {
  try {
    console.log('Stitch request received');
    console.log(JSON.stringify({
      project_id: req.body?.project_id || '',
      chunk_count: Array.isArray(req.body?.chunk_urls) ? req.body.chunk_urls.length : 'not_array',
      has_voice_url: !!(
        req.body?.voice_url ||
        req.body?.voice_file_url ||
        req.body?.voice_public_url
      ),
      has_music_url: !!(
        req.body?.music_url ||
        req.body?.music_file_url
      )
    }));

    if (RENDER_TOKEN && req.header('x-render-token') !== RENDER_TOKEN) {
      return res.status(401).json({ status: 'failed', error: 'Unauthorized' });
    }

    const job = req.body || {};
    const projectId = safeName(job.project_id || 'project');
    const stitchId = safeName(job.render_id || `stitch_${crypto.randomUUID()}`);
    const chunks = Array.isArray(job.chunk_urls) ? job.chunk_urls : [];

    if (!chunks.length) {
      return res.status(400).json({
        status: 'failed',
        error: 'No chunk_urls supplied'
      });
    }

    const jobDir = path.join(WORK_DIR, `${projectId}-${stitchId}`);
    await fs.mkdir(jobDir, { recursive: true });

    const chunkFiles = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const url = typeof chunk === 'string' ? chunk : chunk.url;

      if (!url) continue;

      const chunkPath = path.join(jobDir, `chunk-${i}.mp4`);
      await download(url, chunkPath);
      chunkFiles.push(chunkPath);
    }

    if (!chunkFiles.length) {
      return res.status(400).json({
        status: 'failed',
        error: 'No valid chunk files downloaded'
      });
    }

    const concatFile = path.join(jobDir, 'chunks.txt');
    await fs.writeFile(
      concatFile,
      chunkFiles.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n')
    );

    const stitchedVideo = path.join(jobDir, 'stitched-video.mp4');

    await run('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c', 'copy',
      stitchedVideo
    ]);

    const voiceUrl = job.voice_url || job.voice_file_url || job.voice_public_url;
    const musicUrl = job.music_url || job.music_file_url || '';

    const outputName = safeName(
      job.output_name || `${projectId}_long_video`
    ) + '.mp4';

    const outputPath = path.join(WORK_DIR, outputName);

    if (voiceUrl) {
      const voicePath = path.join(jobDir, `voice${extensionFromUrl(voiceUrl, '.mp3')}`);
      await download(voiceUrl, voicePath);

      if (musicUrl) {
        const musicPath = path.join(jobDir, `music${extensionFromUrl(musicUrl, '.mp3')}`);
        await download(musicUrl, musicPath);

        await run('ffmpeg', [
          '-y',
          '-i', stitchedVideo,
          '-i', voicePath,
          '-i', musicPath,
          '-filter_complex',
          '[1:a]volume=1.0[narration];[2:a]volume=0.12[music];[narration][music]amix=inputs=2:duration=first[aout]',
          '-map', '0:v',
          '-map', '[aout]',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          outputPath
        ]);
      } else {
        await run('ffmpeg', [
          '-y',
          '-i', stitchedVideo,
          '-i', voicePath,
          '-map', '0:v',
          '-map', '1:a',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest',
          outputPath
        ]);
      }
    } else {
      await fs.copyFile(stitchedVideo, outputPath);
    }

    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const finalUrl = `${base}/files/${encodeURIComponent(outputName)}`;

    res.json({
      status: 'complete',
      project_id: job.project_id || '',
      render_id: stitchId,
      file: outputName,
      render_url: finalUrl,
      long_video_public_url: finalUrl,
      public_url: finalUrl,
      chunk_count: chunkFiles.length
    });
  } catch (error) {
    console.error('Stitch failed:', error);
    res.status(500).json({
      status: 'failed',
      error: error.message || String(error)
    });
  }
});
function normalizeScenes(job) {
  if (Array.isArray(job.scenes)) return job.scenes;
  if (Array.isArray(job.timeline?.scenes)) return job.timeline.scenes;

  if (Array.isArray(job.selected_assets)) {
    return job.selected_assets.map(asset => ({
      ...asset,
      asset_url: asset.url || asset.preview,
      duration: asset.duration || 5
    }));
  }

  return [];
}

async function download(url, dest) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  await pipeline(response.body, createWriteStream(dest));
}

async function renderSegment(input, output, options) {
  const { duration, width, height, fps } = options;
  const ext = path.extname(input).toLowerCase();
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);

  if (imageExts.has(ext)) {
    await run('ffmpeg', [
      '-y',
      '-loop', '1',
      '-t', String(duration),
      '-i', input,
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      output
    ]);

    return;
  }

  await run('ffmpeg', [
    '-y',
    '-i', input,
    '-t', String(duration),
    '-vf',
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
    '-r', String(fps),
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(-3000)}`));
      }
    });
  });
}

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'file';
}

function extensionFromUrl(url, fallback = '.mp4') {
  try {
    const ext = path.extname(new URL(url).pathname);
    return ext || fallback;
  } catch {
    return fallback;
  }
}

app.listen(PORT, () => {
  console.log(`Asterion FFmpeg render worker listening on ${PORT}`);
});
