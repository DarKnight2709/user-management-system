import {
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
  ParseFilePipe,
  UnprocessableEntityException,
} from '@nestjs/common';
import sharp from 'sharp';
import { IsJpegValidator } from '@/common/validators/is-jpeg.validator.js';

@Injectable()
export class JpegAvatarPipe extends ParseFilePipe {
  constructor() {
    super({
      validators: [new IsJpegValidator()],
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      fileIsRequired: true,
    });
  }

  override async transform(
    file: Express.Multer.File | undefined,
  ): Promise<Express.Multer.File> {
    await super.transform(file);
    // The parent rejects missing files before image processing.
    if (!file) {
      throw new UnprocessableEntityException('File is required');
    }
    let buffer: Buffer;
    try {
      // Decode the image to validate its content.
      // Limit input pixels to bound decoding memory and processing work.
      const image = sharp(file.buffer, {
        limitInputPixels: 16_000_000,
        failOn: 'warning',
      });
      const metadata = await image.metadata();
      if (metadata.format !== 'jpeg') {
        throw new Error('Expected JPEG input');
      }

      // Output forces decoding; metadata inspection alone is insufficient.
      // Apply EXIF orientation before stripping metadata during encoding.
      buffer = await image
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch {
      throw new UnprocessableEntityException(
        'Avatar must be a valid JPEG with at most 16 million pixels.',
      );
    }

    if (buffer.length > 2 * 1024 * 1024) {
      throw new PayloadTooLargeException(
        'Processed avatar must not exceed 2 MB.',
      );
    }

    return { ...file, buffer, size: buffer.length, mimetype: 'image/jpeg' };
  }
}
