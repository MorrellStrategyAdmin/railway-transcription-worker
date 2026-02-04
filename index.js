const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { AssemblyAI } = require('assemblyai');

const execAsync = promisify(exec);
const app = express();
app.use(cors());
app.use(express.json());

// Initialize AssemblyAI client
const assemblyai = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY
});

// In-memory job tracking
const jobs = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeJobs: jobs.size
  });
});

// Get job status
app.get('/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

// Transcribe endpoint - queues job and returns immediately
app.post('/transcribe', async (req, res) => {
  const { url, callbackUrl } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  // Generate job ID
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Initialize job status
  jobs.set(jobId, {
    jobId,
    url,
    status: 'queued',
    createdAt: new Date().toISOString()
  });

  // Respond immediately with job ID
  res.json({
    status: 'queued',
    jobId,
    url,
    message: 'Job queued for processing'
  });

  // Process in background
  processTranscription(jobId, url, callbackUrl);
});

async function processTranscription(jobId, url, callbackUrl) {
  const tempDir = `/tmp/transcribe_${jobId}`;

  // Update job status
  jobs.set(jobId, {
    ...jobs.get(jobId),
    status: 'processing',
    startedAt: new Date().toISOString()
  });

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // Step 1: Download video with yt-dlp and extract audio
    console.log(`[${jobId}] Downloading: ${url}`);

    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: 'downloading'
    });

    const audioPath = path.join(tempDir, 'audio.mp3');

    try {
      await execAsync(
        `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${path.join(tempDir, 'audio.%(ext)s')}" "${url}"`,
        { timeout: 300000 } // 5 min timeout for download
      );
    } catch (downloadError) {
      throw new Error(`Download failed: ${downloadError.message}`);
    }

    // Check if audio file was created
    try {
      await fs.access(audioPath);
    } catch {
      // Try to find any audio file in temp dir
      const files = await fs.readdir(tempDir);
      const audioFile = files.find(f => f.endsWith('.mp3') || f.endsWith('.m4a') || f.endsWith('.wav'));
      if (!audioFile) {
        throw new Error('Audio file was not created. Video may be private or unavailable.');
      }
    }

    // Step 2: Transcribe with AssemblyAI
    console.log(`[${jobId}] Transcribing with AssemblyAI...`);

    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: 'transcribing'
    });

    const transcript = await assemblyai.transcripts.transcribe({
      audio: audioPath,
      speech_models: ['universal-2']
    });

    if (transcript.status === 'error') {
      throw new Error(`AssemblyAI error: ${transcript.error}`);
    }

    const result = {
      jobId,
      url,
      transcript: transcript.text,
      status: 'completed',
      completedAt: new Date().toISOString()
    };

    // Update job with result
    jobs.set(jobId, result);

    console.log(`[${jobId}] Success: ${transcript.text.length} chars`);

    // Step 3: Send result to callback if provided
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result)
        });
        console.log(`[${jobId}] Callback sent to ${callbackUrl}`);
      } catch (callbackError) {
        console.error(`[${jobId}] Callback failed:`, callbackError.message);
      }
    }

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);

    const errorResult = {
      jobId,
      url,
      error: error.message,
      status: 'failed',
      failedAt: new Date().toISOString()
    };

    jobs.set(jobId, errorResult);

    // Send error to callback if provided
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorResult)
        });
      } catch (callbackError) {
        console.error(`[${jobId}] Error callback failed:`, callbackError.message);
      }
    }
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Clean up old jobs after 1 hour
    setTimeout(() => {
      jobs.delete(jobId);
    }, 60 * 60 * 1000);
  }
}

// List all jobs (for debugging)
app.get('/jobs', (req, res) => {
  const allJobs = Array.from(jobs.values());
  res.json({
    total: allJobs.length,
    jobs: allJobs
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Transcription worker listening on port ${PORT}`);
  console.log(`AssemblyAI configured: ${process.env.ASSEMBLYAI_API_KEY ? 'Yes' : 'No'}`);
});
