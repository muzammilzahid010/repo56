// Video merger utility using local FFmpeg
// Downloads videos from URLs, merges them sequentially, and uploads to Cloudinary

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ObjectStorageService } from './objectStorage';
import { uploadVideoToCloudinary } from './cloudinary.js';

const execAsync = promisify(exec);
const objectStorageService = new ObjectStorageService();

export async function mergeVideosWithFFmpeg(videoUrls: string[]): Promise<string> {
  if (videoUrls.length === 0) {
    throw new Error('No video URLs provided for merging');
  }

  if (videoUrls.length > 14) {
    throw new Error('Cannot merge more than 14 videos at once');
  }

  // Create unique temp directory for this merge operation
  const uniqueId = randomUUID();
  const tempDir = path.join('/tmp', `video-merge-${uniqueId}`);
  const listFile = path.join(tempDir, 'filelist.txt');
  const outputFile = path.join(tempDir, 'merged-output.mp4');

  try {
    // Create temp directory if it doesn't exist
    if (!existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true });
    }

    console.log(`[FFmpeg Merger] Starting merge of ${videoUrls.length} videos in ${tempDir}`);

    // Step 1: Download all videos to temp directory
    const downloadedFiles: string[] = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const filename = path.join(tempDir, `video-${i + 1}.mp4`);
      console.log(`[FFmpeg Merger] Downloading video ${i + 1}/${videoUrls.length}...`);
      
      const response = await fetch(videoUrls[i]);
      if (!response.ok) {
        throw new Error(`Failed to download video ${i + 1}: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      await writeFile(filename, Buffer.from(buffer));
      downloadedFiles.push(filename);
      console.log(`[FFmpeg Merger] Downloaded video ${i + 1} (${buffer.byteLength} bytes)`);
    }

    // Step 2: Create file list for FFmpeg concat
    const fileListContent = downloadedFiles
      .map(file => `file '${file}'`)
      .join('\n');
    await writeFile(listFile, fileListContent);
    console.log(`[FFmpeg Merger] Created file list with ${downloadedFiles.length} videos`);

    // Step 3: Merge videos using FFmpeg concat demuxer
    console.log(`[FFmpeg Merger] Running FFmpeg to merge videos...`);
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;
    
    try {
      const { stdout, stderr } = await execAsync(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 });
      console.log(`[FFmpeg Merger] FFmpeg completed successfully`);
      if (stderr) {
        console.log(`[FFmpeg Merger] FFmpeg stderr:`, stderr.substring(0, 500));
      }
    } catch (ffmpegError: any) {
      console.error(`[FFmpeg Merger] FFmpeg error:`, ffmpegError.stderr || ffmpegError.message);
      throw new Error(`FFmpeg failed: ${ffmpegError.message}`);
    }

    // Step 4: Upload merged video to Cloudinary
    console.log(`[FFmpeg Merger] Uploading merged video to Cloudinary...`);
    
    // Check file size
    const fileStats = statSync(outputFile);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    console.log(`[FFmpeg Merger] Merged video size: ${fileSizeMB} MB`);
    
    // Upload video file directly from disk to Cloudinary
    const uploadUrl = await uploadVideoToCloudinary(outputFile);
    console.log(`[FFmpeg Merger] Cloudinary upload complete! URL: ${uploadUrl}`);

    // Step 5: Clean up temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
      console.log(`[FFmpeg Merger] Cleanup successful`);
    } catch (cleanupError) {
      console.error(`[FFmpeg Merger] Cleanup failed:`, cleanupError);
    }

    return uploadUrl;
  } catch (error) {
    console.error(`[FFmpeg Merger] Error during merge process:`, error);
    
    // Clean up on error - remove entire temp directory
    try {
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
        console.log(`[FFmpeg Merger] Error cleanup successful`);
      }
    } catch (cleanupError) {
      console.error(`[FFmpeg Merger] Error cleanup failed:`, cleanupError);
    }
    
    throw new Error(`Failed to merge videos with FFmpeg: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Merge UGC videos with trimming - first video full, subsequent videos trimmed 1s from start
export async function mergeUGCVideosWithTrim(videoUrls: string[]): Promise<{ filePath: string; tempDir: string }> {
  if (videoUrls.length === 0) {
    throw new Error('No video URLs provided for merging');
  }

  if (videoUrls.length > 10) {
    throw new Error('Cannot merge more than 10 videos at once');
  }

  const uniqueId = randomUUID();
  const tempDir = path.join('/tmp', `ugc-merge-${uniqueId}`);
  const listFile = path.join(tempDir, 'filelist.txt');
  const outputFile = path.join(tempDir, 'merged-ugc-output.mp4');

  try {
    if (!existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true });
    }

    console.log(`[UGC Merger] Starting merge of ${videoUrls.length} videos with trimming`);

    // Step 1: Download all videos
    const downloadedFiles: string[] = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const filename = path.join(tempDir, `video-${i + 1}.mp4`);
      console.log(`[UGC Merger] Downloading video ${i + 1}/${videoUrls.length}...`);
      
      const response = await fetch(videoUrls[i]);
      if (!response.ok) {
        throw new Error(`Failed to download video ${i + 1}: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      await writeFile(filename, Buffer.from(buffer));
      downloadedFiles.push(filename);
      console.log(`[UGC Merger] Downloaded video ${i + 1} (${buffer.byteLength} bytes)`);
    }

    // Step 2: Process videos - first one full, rest trimmed 1s from start
    const processedFiles: string[] = [];
    for (let i = 0; i < downloadedFiles.length; i++) {
      const inputFile = downloadedFiles[i];
      const processedFile = path.join(tempDir, `processed-${i + 1}.mp4`);
      
      if (i === 0) {
        // First video - keep full, just re-encode for consistency
        console.log(`[UGC Merger] Processing video ${i + 1} (full length)...`);
        const cmd = `ffmpeg -i "${inputFile}" -c:v libx264 -c:a aac -y "${processedFile}"`;
        await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
      } else {
        // Subsequent videos - trim 1 second from start
        console.log(`[UGC Merger] Processing video ${i + 1} (trimming 1s from start)...`);
        const cmd = `ffmpeg -i "${inputFile}" -ss 1 -c:v libx264 -c:a aac -y "${processedFile}"`;
        await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });
      }
      
      processedFiles.push(processedFile);
    }

    // Step 3: Create file list for concat
    const fileListContent = processedFiles
      .map(file => `file '${file}'`)
      .join('\n');
    await writeFile(listFile, fileListContent);
    console.log(`[UGC Merger] Created file list with ${processedFiles.length} processed videos`);

    // Step 4: Merge all processed videos
    console.log(`[UGC Merger] Merging all videos...`);
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy -y "${outputFile}"`;
    
    try {
      await execAsync(ffmpegCommand, { maxBuffer: 1024 * 1024 * 50 });
      console.log(`[UGC Merger] FFmpeg merge completed successfully`);
    } catch (ffmpegError: any) {
      console.error(`[UGC Merger] FFmpeg merge error:`, ffmpegError.stderr || ffmpegError.message);
      throw new Error(`FFmpeg merge failed: ${ffmpegError.message}`);
    }

    // Return file path and tempDir for direct download (no Cloudinary upload)
    const fileStats = statSync(outputFile);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    console.log(`[UGC Merger] Merged video ready: ${fileSizeMB} MB at ${outputFile}`);
    
    return { filePath: outputFile, tempDir };
  } catch (error) {
    console.error(`[UGC Merger] Error during merge process:`, error);
    
    try {
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(`[UGC Merger] Error cleanup failed:`, cleanupError);
    }
    
    throw new Error(`Failed to merge UGC videos: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function mergeVideosWithFFmpegTemporary(
  videoUrls: string[], 
  expiryHours: number = 24
): Promise<{ videoPath: string; expiresAt: string }> {
  if (videoUrls.length === 0) {
    throw new Error('No video URLs provided for merging');
  }

  if (videoUrls.length > 14) {
    throw new Error('Cannot merge more than 14 videos at once');
  }

  const uniqueId = randomUUID();
  const tempDir = path.join('/tmp', `video-merge-${uniqueId}`);
  const listFile = path.join(tempDir, 'filelist.txt');
  const outputFile = path.join(tempDir, 'merged-output.mp4');

  try {
    if (!existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true });
    }

    console.log(`[FFmpeg Temporary] Starting merge of ${videoUrls.length} videos in ${tempDir}`);

    const downloadedFiles: string[] = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const filename = path.join(tempDir, `video-${i + 1}.mp4`);
      console.log(`[FFmpeg Temporary] Downloading video ${i + 1}/${videoUrls.length}...`);
      
      const response = await fetch(videoUrls[i]);
      if (!response.ok) {
        throw new Error(`Failed to download video ${i + 1}: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      await writeFile(filename, Buffer.from(buffer));
      downloadedFiles.push(filename);
      console.log(`[FFmpeg Temporary] Downloaded video ${i + 1} (${buffer.byteLength} bytes)`);
    }

    const fileListContent = downloadedFiles
      .map(file => `file '${file}'`)
      .join('\n');
    await writeFile(listFile, fileListContent);
    console.log(`[FFmpeg Temporary] Created file list with ${downloadedFiles.length} videos`);

    console.log(`[FFmpeg Temporary] Running FFmpeg to merge videos...`);
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;
    
    try {
      const { stdout, stderr } = await execAsync(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 });
      console.log(`[FFmpeg Temporary] FFmpeg completed successfully`);
      if (stderr) {
        console.log(`[FFmpeg Temporary] FFmpeg stderr:`, stderr.substring(0, 500));
      }
    } catch (ffmpegError: any) {
      console.error(`[FFmpeg Temporary] FFmpeg error:`, ffmpegError.stderr || ffmpegError.message);
      throw new Error(`FFmpeg failed: ${ffmpegError.message}`);
    }

    console.log(`[FFmpeg Temporary] Uploading to temporary storage (expires in ${expiryHours} hours)...`);
    const videoPath = await objectStorageService.uploadTemporaryVideo(outputFile, expiryHours);

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + expiryHours);

    console.log(`[FFmpeg Temporary] Upload complete! Path: ${videoPath}`);
    console.log(`[FFmpeg Temporary] Expires at: ${expiryDate.toISOString()}`);

    try {
      await rm(tempDir, { recursive: true, force: true });
      console.log(`[FFmpeg Temporary] Cleanup successful`);
    } catch (cleanupError) {
      console.error(`[FFmpeg Temporary] Cleanup failed:`, cleanupError);
    }

    return {
      videoPath,
      expiresAt: expiryDate.toISOString()
    };
  } catch (error) {
    console.error(`[FFmpeg Temporary] Error during merge process:`, error);
    
    try {
      if (existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
        console.log(`[FFmpeg Temporary] Error cleanup successful`);
      }
    } catch (cleanupError) {
      console.error(`[FFmpeg Temporary] Error cleanup failed:`, cleanupError);
    }
    
    throw new Error(`Failed to merge videos with FFmpeg: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
