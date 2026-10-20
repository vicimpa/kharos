//! Двоичный провод: целые — varint (LEB128), знаковые — зигзагом; число столбца — самым коротким видом, который
//! передаёт его точно: ноль, целое, f32 или f64; строки и JSON — длиной и байтами UTF-8.

/// Вид числа в проводе.
const ZERO: u8 = 0;
const INTEGER: u8 = 1;
const SINGLE: u8 = 2;
const DOUBLE: u8 = 3;

#[derive(Default)]
pub struct Writer {
  pub bytes: Vec<u8>,
}

impl Writer {
  pub fn u8(&mut self, value: u8) {
    self.bytes.push(value);
  }

  pub fn uint(&mut self, mut value: u64) {
    loop {
      let byte = (value & 0x7f) as u8;
      value >>= 7;
      if value == 0 {
        self.bytes.push(byte);
        return;
      }
      self.bytes.push(byte | 0x80);
    }
  }

  pub fn int(&mut self, value: i64) {
    self.uint(((value << 1) ^ (value >> 63)) as u64);
  }

  pub fn num(&mut self, value: f64) {
    if value.to_bits() == 0 {
      self.u8(ZERO);
    } else if value.fract() == 0.0 && value.abs() < 9.0e15 && value != 0.0 {
      self.u8(INTEGER);
      self.int(value as i64);
    } else if (value as f32) as f64 == value || value.is_nan() {
      self.u8(SINGLE);
      self.bytes.extend_from_slice(&(value as f32).to_le_bytes());
    } else {
      self.u8(DOUBLE);
      self.bytes.extend_from_slice(&value.to_le_bytes());
    }
  }

  pub fn text(&mut self, text: &str) {
    self.uint(text.len() as u64);
    self.bytes.extend_from_slice(text.as_bytes());
  }

  pub fn blob(&mut self, bytes: &[u8]) {
    self.uint(bytes.len() as u64);
    self.bytes.extend_from_slice(bytes);
  }

  pub fn json(&mut self, value: &serde_json::Value) {
    self.text(&value.to_string());
  }
}

pub struct Reader<'a> {
  bytes: &'a [u8],
  at: usize,
}

pub type Error = String;

impl<'a> Reader<'a> {
  pub fn new(bytes: &'a [u8]) -> Self {
    Self { bytes, at: 0 }
  }

  pub fn done(&self) -> bool {
    self.at >= self.bytes.len()
  }

  fn take(&mut self, count: usize) -> Result<&'a [u8], Error> {
    let part = self.bytes.get(self.at..self.at + count).ok_or("кадр обрывается")?;
    self.at += count;
    Ok(part)
  }

  pub fn u8(&mut self) -> Result<u8, Error> {
    Ok(self.take(1)?[0])
  }

  pub fn uint(&mut self) -> Result<u64, Error> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
      let byte = self.u8()?;
      value |= ((byte & 0x7f) as u64) << shift;
      if byte & 0x80 == 0 {
        return Ok(value);
      }
    }
    Err("varint длиннее 64 бит".into())
  }

  /// Целое, которое должно поместиться в u32: номер сущности, компонента, счётчик.
  pub fn u32(&mut self) -> Result<u32, Error> {
    u32::try_from(self.uint()?).map_err(|_| "число не помещается в u32".into())
  }

  /// Длина списка: не больше, чем осталось байтов, — чтобы чужой кадр не заказал память без меры.
  pub fn count(&mut self) -> Result<usize, Error> {
    let count = self.uint()? as usize;
    if count > self.bytes.len() - self.at {
      return Err("список длиннее кадра".into());
    }
    Ok(count)
  }

  pub fn int(&mut self) -> Result<i64, Error> {
    let raw = self.uint()?;
    Ok(((raw >> 1) as i64) ^ -((raw & 1) as i64))
  }

  pub fn num(&mut self) -> Result<f64, Error> {
    match self.u8()? {
      ZERO => Ok(0.0),
      INTEGER => Ok(self.int()? as f64),
      SINGLE => Ok(f32::from_le_bytes(self.take(4)?.try_into().expect("4 байта")) as f64),
      DOUBLE => Ok(f64::from_le_bytes(self.take(8)?.try_into().expect("8 байт"))),
      other => Err(format!("неизвестный вид числа {other}")),
    }
  }

  pub fn text(&mut self) -> Result<String, Error> {
    let count = self.count()?;
    String::from_utf8(self.take(count)?.to_vec()).map_err(|_| "строка не UTF-8".into())
  }

  pub fn blob(&mut self) -> Result<&'a [u8], Error> {
    let count = self.count()?;
    self.take(count)
  }

  pub fn json(&mut self) -> Result<serde_json::Value, Error> {
    serde_json::from_str(&self.text()?).map_err(|error| format!("JSON: {error}"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn numbers_round_trip_exactly_and_short() {
    let values = [0.0, -0.0, 1.0, -7.0, 1e15, 0.5, 0.1, 1.0 / 3.0, f64::MAX, f64::MIN_POSITIVE, -123.456, 4294967295.0];
    let mut writer = Writer::default();
    for value in values {
      writer.num(value);
    }
    let mut reader = Reader::new(&writer.bytes);
    for value in values {
      assert_eq!(reader.num().unwrap().to_bits(), value.to_bits(), "{value}");
    }
    assert!(reader.done());
    let mut short = Writer::default();
    short.num(3.0);
    short.num(0.5);
    assert_eq!(short.bytes.len(), 2 + 5);
  }

  #[test]
  fn broken_input_is_an_error_not_a_panic() {
    let mut writer = Writer::default();
    writer.text("привет");
    let cut = &writer.bytes[..4];
    assert!(Reader::new(cut).text().is_err());
    assert!(Reader::new(&[0xff; 12]).uint().is_err());
    assert!(Reader::new(&[200]).count().is_err());
  }
}
