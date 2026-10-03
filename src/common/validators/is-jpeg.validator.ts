import { FileValidator } from '@nestjs/common';

export class IsJpegValidator extends FileValidator {
  constructor() {
    super({});
  }

  isValid(file?: Express.Multer.File): boolean {
    if (!file?.buffer || file.buffer.length < 3) {
      return false;
    }

    const firstBytesHex = file.buffer
      .subarray(0, 3)
      .toString('hex')
      .toUpperCase();

    return firstBytesHex === 'FFD8FF';
  }
  buildErrorMessage(): string {
    return 'File claims to be an image but binary signature is not JPEG.';
  }
}
