//! Запись видео сценария: кадры RGBA уходят трубой в ffmpeg (внешняя программа, в сборку не входит), он пишет H.264.
//! Звук, если он есть, — отдельной дорожкой WAV, которую ffmpeg кладёт к видео, когда запись кончилась.

use std::io::Write as _;
use std::process::{Child, ChildStdin, Command, Stdio};

pub struct Recorder {
  path: String,
  /// Видео без звука: туда пишет ffmpeg, пока идёт запись; со звуком его потом склеивают с дорожкой.
  video: String,
  child: Child,
  stdin: Option<ChildStdin>,
  size: [u32; 2],
  pub frames: u64,
}

impl Recorder {
  /// Запись в path кадров size (физические пиксели) с частотой fps. sound — будет ли звуковая дорожка.
  pub fn start(path: &str, size: [u32; 2], fps: f64, sound: bool) -> Result<Self, String> {
    let video = if sound { format!("{path}.video.mp4") } else { path.to_string() };
    let mut child = Command::new("ffmpeg")
      .args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{}x{}", size[0], size[1]), "-r", &fps.to_string(), "-i", "-"])
      // H.264 и yuv420p требуют чётных сторон: нечётную добивает пустая полоса.
      .args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", &video])
      .stdin(Stdio::piped())
      .spawn()
      .map_err(|error| format!("запись видео: нужен ffmpeg ({error})"))?;
    let stdin = child.stdin.take();
    Ok(Self { path: path.to_string(), video, child, stdin, size, frames: 0 })
  }

  pub fn size(&self) -> [u32; 2] {
    self.size
  }

  /// Кадр строками сверху вниз, RGBA.
  pub fn frame(&mut self, pixels: &[u8]) -> Result<(), String> {
    let stdin = self.stdin.as_mut().ok_or("запись уже кончилась")?;
    stdin.write_all(pixels).map_err(|error| format!("запись видео {}: {error}", self.path))?;
    self.frames += 1;
    Ok(())
  }

  /// Конец записи; audio — звуковая дорожка WAV, которую положить к видео.
  pub fn finish(mut self, audio: Option<&str>) -> Result<(), String> {
    drop(self.stdin.take());
    let status = self.child.wait().map_err(|error| format!("ffmpeg: {error}"))?;
    if !status.success() {
      return Err(format!("ffmpeg не дописал {}", self.video));
    }
    let Some(audio) = audio else { return Ok(()) };
    let status = Command::new("ffmpeg")
      .args(["-y", "-loglevel", "error", "-i", &self.video, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", &self.path])
      .status()
      .map_err(|error| format!("ffmpeg: {error}"))?;
    if !status.success() {
      return Err(format!("ffmpeg не склеил звук с {}", self.path));
    }
    let _ = std::fs::remove_file(&self.video);
    Ok(())
  }
}

/// Звук в WAV: 32-битные числа с плавающей точкой, каналы вперемешку.
pub fn write_wav(path: &str, channels: &[Vec<f32>], rate: u32) -> Result<(), String> {
  let count = channels.len().max(1) as u16;
  let frames = channels.first().map_or(0, Vec::len);
  let data = (frames * count as usize * 4) as u32;
  let mut bytes = Vec::with_capacity(44 + data as usize);
  bytes.extend_from_slice(b"RIFF");
  bytes.extend_from_slice(&(36 + data).to_le_bytes());
  bytes.extend_from_slice(b"WAVEfmt ");
  bytes.extend_from_slice(&16u32.to_le_bytes());
  bytes.extend_from_slice(&3u16.to_le_bytes());
  bytes.extend_from_slice(&count.to_le_bytes());
  bytes.extend_from_slice(&rate.to_le_bytes());
  bytes.extend_from_slice(&(rate * count as u32 * 4).to_le_bytes());
  bytes.extend_from_slice(&(count * 4).to_le_bytes());
  bytes.extend_from_slice(&32u16.to_le_bytes());
  bytes.extend_from_slice(b"data");
  bytes.extend_from_slice(&data.to_le_bytes());
  for frame in 0..frames {
    for channel in channels {
      bytes.extend_from_slice(&channel[frame].to_le_bytes());
    }
  }
  std::fs::write(path, bytes).map_err(|error| format!("{path}: {error}"))
}
