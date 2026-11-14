const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGE_DIMENSION: u32 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub content_type: &'static str,
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
}

pub fn detect_image_info(bytes: &[u8]) -> Option<ImageInfo> {
    if let Some((width, height)) = parse_png_size(bytes) {
        return Some(ImageInfo {
            content_type: "image/png",
            ext: "png",
            width,
            height,
        });
    }
    if let Some((width, height)) = parse_jpeg_size(bytes) {
        return Some(ImageInfo {
            content_type: "image/jpeg",
            ext: "jpg",
            width,
            height,
        });
    }
    if let Some((width, height)) = parse_webp_size(bytes) {
        return Some(ImageInfo {
            content_type: "image/webp",
            ext: "webp",
            width,
            height,
        });
    }
    None
}

fn clamp_dimensions(width: u32, height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 {
        return None;
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return None;
    }
    Some((width, height))
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let chunk = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes(chunk.try_into().ok()?))
}

fn read_u16_be(bytes: &[u8], offset: usize) -> Option<u16> {
    let chunk = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes(chunk.try_into().ok()?))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let chunk = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes(chunk.try_into().ok()?))
}

fn parse_png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 8 + 4 + 4 + 13 {
        return None;
    }
    if bytes.get(..8)? != PNG_SIGNATURE {
        return None;
    }
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = read_u32_be(bytes, 16)?;
    let height = read_u32_be(bytes, 20)?;
    clamp_dimensions(width, height)
}

fn parse_jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return None;
    }
    let mut offset = 2;

    while offset + 4 <= bytes.len() {
        if bytes[offset] != 0xff {
            return None;
        }
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            return None;
        }
        let marker = bytes[offset];
        offset += 1;

        if marker == 0xd9 {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }

        let segment_length = usize::from(read_u16_be(bytes, offset)?);
        if segment_length < 2 {
            return None;
        }
        let segment_start = offset + 2;
        let segment_end = segment_start.checked_add(segment_length - 2)?;
        if segment_end > bytes.len() {
            return None;
        }

        let is_sof = matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        );
        if is_sof {
            if segment_start + 5 > bytes.len() {
                return None;
            }
            let height = u32::from(read_u16_be(bytes, segment_start + 1)?);
            let width = u32::from(read_u16_be(bytes, segment_start + 3)?);
            return clamp_dimensions(width, height);
        }

        offset = segment_end;
    }

    None
}

fn parse_webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 16 {
        return None;
    }
    if bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WEBP" {
        return None;
    }

    let chunk_type = bytes.get(12..16)?;
    let chunk_size = usize::try_from(read_u32_le(bytes, 16)?).ok()?;
    let chunk_data_offset: usize = 20;
    if chunk_data_offset.checked_add(chunk_size)? > bytes.len() {
        return None;
    }

    if chunk_type == b"VP8X" {
        if chunk_data_offset + 10 > bytes.len() {
            return None;
        }
        let width = 1
            + (u32::from(bytes[chunk_data_offset + 4])
                | (u32::from(bytes[chunk_data_offset + 5]) << 8)
                | (u32::from(bytes[chunk_data_offset + 6]) << 16));
        let height = 1
            + (u32::from(bytes[chunk_data_offset + 7])
                | (u32::from(bytes[chunk_data_offset + 8]) << 8)
                | (u32::from(bytes[chunk_data_offset + 9]) << 16));
        return clamp_dimensions(width, height);
    }

    if chunk_type == b"VP8L" {
        if chunk_data_offset + 5 > bytes.len() || bytes[chunk_data_offset] != 0x2f {
            return None;
        }
        let bits = u32::from(bytes[chunk_data_offset + 1])
            | (u32::from(bytes[chunk_data_offset + 2]) << 8)
            | (u32::from(bytes[chunk_data_offset + 3]) << 16)
            | (u32::from(bytes[chunk_data_offset + 4]) << 24);
        let width = 1 + (bits & 0x3fff);
        let height = 1 + ((bits >> 14) & 0x3fff);
        return clamp_dimensions(width, height);
    }

    if chunk_type == b"VP8 " {
        if chunk_data_offset + 10 > bytes.len() {
            return None;
        }
        if bytes.get(chunk_data_offset + 3..chunk_data_offset + 6)? != [0x9d, 0x01, 0x2a] {
            return None;
        }
        let width = u32::from(read_u16_be(bytes, chunk_data_offset + 6)?) & 0x3fff;
        let height = u32::from(read_u16_be(bytes, chunk_data_offset + 8)?) & 0x3fff;
        return clamp_dimensions(width, height);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&PNG_SIGNATURE);
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn detects_png_dimensions_and_rejects_oversized_metadata() {
        let info = detect_image_info(&png(640, 480)).expect("png");
        assert_eq!(info.content_type, "image/png");
        assert_eq!((info.width, info.height), (640, 480));
        assert!(detect_image_info(&png(20_001, 10)).is_none());
        assert!(detect_image_info(&png(0, 10)).is_none());
    }

    #[test]
    fn detects_webp_vp8x_dimensions() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&18u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8X");
        bytes.extend_from_slice(&10u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(&[0x0f, 0x01, 0x00]);
        bytes.extend_from_slice(&[0x1f, 0x00, 0x00]);
        let info = detect_image_info(&bytes).expect("webp");
        assert_eq!(info.content_type, "image/webp");
        assert_eq!((info.width, info.height), (272, 32));
    }

    #[test]
    fn rejects_unknown_payloads() {
        assert!(detect_image_info(b"not an image").is_none());
    }
}
