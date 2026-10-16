import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

export class CreateOrganizationDto {
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.name === 'string' ? obj.name.trim() : obj.name,
  )
  @IsString()
  @Length(1, 100)
  name: string;

  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    typeof obj.slug === 'string' ? obj.slug.trim().toLowerCase() : obj.slug,
  )
  @IsString()
  @Length(3, 63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'slug must contain lowercase letters or numbers separated by single hyphens',
  })
  slug: string;
}
