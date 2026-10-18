# FFGui

**English** · [简体中文](README.zh.md)

A desktop audio/video toolbox built on Electron + FFmpeg (a GUI for FFmpeg). The interface is
available in Simplified Chinese, Traditional Chinese, English, Japanese and Korean — it follows
the system language by default and can be switched from the top-right corner.

## Features

### Transcoding

- Batch queue: drop or pick several files and they are processed one by one in queue order,
  with per-file progress
- Automatic capability probing: on first launch FFmpeg is queried with
  `ffmpeg -hwaccels / -encoders / -formats` to find the hardware acceleration, encoders and
  containers this machine really supports, and the result is cached; every hardware encoder is
  test-encoded once so the ones the driver rejects (NVENC / QSV / AMF / MediaFoundation /
  VideoToolbox) drop out of the list
- Common formats and codecs: MP4 / MKV / AVI / MOV / WebM / GIF / MP3 / FLAC with
  H.264 / H.265 / AV1 / VP9 / ProRes and more
- Advanced parameters: video bitrate (VBR / CBR), audio bitrate, resolution scaling (WxH or a
  percentage). Leave a field empty and the flag is omitted, letting FFmpeg use its default
- HDR to SDR: tone mapping based on zscale + tonemap
- Audio-only extraction: the video stream is dropped automatically for MP3 / FLAC / WAV output

### Merging

- Drag in videos or audio and reorder them with the drag handles
- Audio-only queue: only audio is concatenated (lossless, resampled for alignment)
- Mixed queue: re-encoded concatenation, so different formats and resolutions can be mixed
  freely; audio files in the queue are merged into the video as a black picture, and video
  segments without an audio track get silence

### Cropping

- Visual selection on a single file: pick or drop one video, pause the native player on a frame,
  click "Draw crop box" and drag a box over the picture area you want to keep. Dragging works in
  any direction, the box is clamped to the picture, the area outside is dimmed, and a box that is
  too small is rejected
- The box is stored as normalized coordinates (0–1) relative to the picture, independent of the
  preview quality. Formats Chromium cannot decode get a low-bitrate preview copy for playback and
  drawing, while the final conversion always runs on the original file and outputs MP4 / H.264 /
  AAC with all audio tracks kept
- Adjustable output quality (high / standard / low) and output directory, with progress and
  cancel; exported dimensions are rounded down to even numbers (1919 → 1918) and existing files
  are never overwritten

### Disc extraction

- DVD / Blu-ray ISO images, already extracted folders (VIDEO_TS / BDMV) and physical disc drives
- Probes titles, duration, chapters, audio tracks and subtitle languages; the longest title is
  selected by default and several titles can be ripped one after another
- Three-state track selection for audio and subtitles: keep everything, keep nothing, or pick
  individual tracks — nothing is dropped silently
- Lossless MKV: the video stream is copied as is. Transcoded MKV / MP4: H.264 plus optional AAC,
  quality high/standard/low, chapters preserved. MP4 cannot carry PGS / VobSub bitmap subtitles,
  so they have to be explicitly set to "keep none"
- Encrypted Blu-ray discs need your own local KEYDB.cfg; online key services are disabled
- Physical drives and encrypted discs still need to be verified on real hardware

## Running and development

### Audio tracks and output files

- Transcoding keeps all audio tracks by default; enter a 1-based track number to output only that
  track. Batch jobs use each file's own track order.
- MP3, FLAC, WAV and FLV are single-track outputs, so multi-track input has to select a track
  explicitly; other tracks are never dropped silently. Pick MKV or M4A if you need all tracks.
- MKV transcoding also keeps subtitles and attachments; other output containers receive only the
  selected video and audio streams, with no implicit subtitle or attachment conversion.
- Lossless trimming maps every original stream; if the source format cannot be remuxed for some
  stream, the job fails instead of dropping it silently. Time inputs and sliders keep
  millisecond precision, though lossless cuts are still bound to keyframes.
- Cropping outputs a single MP4 (H.264 + AAC). The box is a normalized rectangle relative to the
  picture and is converted using the video's real resolution, so an area drawn on the preview
  copy maps to the same area in the output.
- Merging concatenates track by track and fills missing tracks with silence. Make sure the track
  order is consistent across files; every track is resampled to 44.1 kHz stereo.
- Transcode, trim and merge jobs automatically number the output when a file with that name
  already exists, so neither source files nor earlier results are overwritten.

### Regression tests

`npm test` runs on the Node built-in test runner — no extra test framework to install. Put ffmpeg
and ffprobe on PATH first, or point the `FFMPEG` / `FFPROBE` environment variables at them. The
FFmpeg build used by the tests must include libx264, AAC, libmp3lame, FLAC and the subtitles
filter.

The tests create temporary media and clean it up afterwards, covering multi-track
transcoding/trimming/merging, track selection, subtitle attachments, overwrite protection,
progress chunk parsing and millisecond timestamps. Manual verification of the whole app is still
done with `npm start`.

```bash
npm install
npm start          # run in development
npm run package    # package the app (output in out/)
npm run make       # build installers (Windows: NSIS / macOS: zip / Linux: deb, rpm)
```

### Getting FFmpeg

- **Windows**: download an FFmpeg build (the
  [gyan.dev full build](https://www.gyan.dev/ffmpeg/builds/) is recommended) and put
  `ffmpeg.exe` into the project's `bin/` directory (see `bin/README.md`)
- **macOS**: `brew install ffmpeg`
- **Linux**: install ffmpeg with your distribution's package manager (taken from PATH)

## Tech stack

- Electron 41, no frontend framework and no bundler: the renderer is plain HTML / CSS / JS
- The main process probes and caches FFmpeg capabilities, opens file dialogs, spawns ffmpeg and
  parses its `-progress` output
- Disc extraction runs in a Rust sidecar using freemkv-engine to read discs and remux losslessly;
  FFmpeg handles the transcoding that follows
- The renderer reaches a restricted IPC API through the preload contextBridge
  (contextIsolation is enabled)

## References

- [freemkv](https://github.com/freemkv/freemkv) — upstream project of freemkv-engine used by the
  disc sidecar to read discs and remux lossless MKV
- [FFmpeg](https://git.ffmpeg.org/ffmpeg.git) — the audio/video engine bundled and invoked by this
  project

## License

LGPL-3.0-or-later
