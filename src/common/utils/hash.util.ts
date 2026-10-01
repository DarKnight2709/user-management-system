import bcrypt from 'bcrypt';

export async function hash(password: string): Promise<string> {
  const saltRound = 10;
  const salt = await bcrypt.genSalt(saltRound);
  return bcrypt.hash(password, salt);
}

export async function compare(
  password: string,
  hashed: string,
): Promise<boolean> {
  return bcrypt.compare(password, hashed);
}
