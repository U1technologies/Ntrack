import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP-recommended parameters (19 MiB, 2 iterations).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export const verifyPassword = async (passwordHash: string, password: string): Promise<boolean> => {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};

/** Precomputed hash so unknown-email logins take the same time as wrong-password logins. */
let dummyHash: Promise<string> | null = null;
export const burnPasswordCheck = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword('ntrack-timing-equaliser');
  await verifyPassword(await dummyHash, password);
};
