import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface RequestUser {
  id: string;
  username: string;
  email: string;
}
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const req: Request = ctx.switchToHttp().getRequest<Request>();

    const user = req.user as RequestUser | undefined;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);
