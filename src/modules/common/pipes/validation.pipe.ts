import {
  HttpStatus,
  Injectable,
  Optional,
  UnprocessableEntityException,
  ValidationError,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';

@Injectable()
export class InputValidationPipe extends ValidationPipe {
  constructor(@Optional() options?: ValidationPipeOptions) {
    super({
      ...options,
      // security: strip away the fields that are not declared and decorated in the Dto
      whitelist: true,
      // security: sent bad request when the above situation happens (exist the unexpected fields)
      forbidNonWhitelisted: true,
      // Enables transformation of plain objects into DTO instances.
      transform: true,
      // Enables automatic type conversion based on reflected TypeScript types.
      transformOptions: {
        enableImplicitConversion: true,
      },
      // All validation errors will return HTTP code 422 instead of default 400
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,

      exceptionFactory: (errors: ValidationError[]) => {
        const formattedErrors = formatValidationError(errors);

        return new UnprocessableEntityException({
          message: 'Invalid Data',
          errors: formattedErrors,
          errorType: 'ValidationError',
        });
      },
    });
  }
}

interface FormattedValidationError {
  field: string;
  messages?: { [type: string]: string };
  nestedErrors: FormattedValidationError[];
}

function formatValidationError(
  errors: ValidationError[],
): FormattedValidationError[] {
  return errors.map((error) => ({
    field: error.property,
    messages: error.constraints,
    nestedErrors: error.children ? formatValidationError(error.children) : [],
  }));
}
