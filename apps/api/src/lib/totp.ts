import { authenticator } from 'otplib';
import QRCode from 'qrcode';

authenticator.options = { window: 1 };

export const generateTotpSecret = (): string => authenticator.generateSecret();

export const verifyTotp = (secret: string, code: string): boolean => /^\d{6}$/.test(code) && authenticator.verify({ token: code, secret });

export const totpQrCode = async (email: string, secret: string): Promise<string> =>
  QRCode.toDataURL(authenticator.keyuri(email, 'NTrack by Nextagmedia', secret));
