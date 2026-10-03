/**
 * Bootstraps a fresh installation: permission catalogue, the Nextagmedia organization with its
 * system roles, and the first platform super admin (from SEED_ADMIN_* env vars).
 * Safe to re-run: existing records are kept and system roles are refreshed.
 *
 * Pass --demo to also create clearly labelled DEMO DATA for local previews.
 */
import { prisma } from '@ntrack/db';
import { hashPassword } from './lib/password';
import { provisionOrganization, syncPermissionCatalogue, syncSystemRoles } from './services/provisioning';
import { seedDemoData } from './seed-demo';

const main = async () => {
  await syncPermissionCatalogue(prisma);

  let organization = await prisma.organization.findUnique({ where: { slug: 'nextagmedia' } });
  if (!organization) {
    organization = await provisionOrganization(prisma, { name: 'Nextagmedia', slug: 'nextagmedia', timezone: 'Asia/Kolkata', currency: 'USD' });
    console.log(`Created organization ${organization.name} (${organization.publicId})`);
  } else {
    await syncSystemRoles(prisma, organization.id);
  }

  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
    const existing = await prisma.user.findUnique({ where: { email } });
    if (!existing) {
      await prisma.user.create({
        data: { email, name: process.env.SEED_ADMIN_NAME ?? 'NTrack Admin', passwordHash: await hashPassword(password), isPlatformAdmin: true },
      });
      console.log(`Created platform super admin ${email}`);
    }
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set; skipping super admin creation.');
  }

  if (process.argv.includes('--demo')) await seedDemoData(prisma, organization.id);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
