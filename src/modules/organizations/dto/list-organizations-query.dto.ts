import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class ListOrganizationsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
