import { connect, disconnect, model } from 'mongoose';
import * as bcrypt from 'bcryptjs';

import { User, UserSchema } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

interface SeedAccount {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

function getRequiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to run the seed command`);
  }
  return value;
}

function getSeedAccounts(): SeedAccount[] {
  return [
    {
      name: 'Development Admin',
      email: getRequiredEnvironment('SEED_ADMIN_EMAIL').toLowerCase(),
      password: getRequiredEnvironment('SEED_ADMIN_PASSWORD'),
      role: UserRole.ADMIN,
    },
    {
      name: 'Development Moderator',
      email: getRequiredEnvironment('SEED_MODERATOR_EMAIL').toLowerCase(),
      password: getRequiredEnvironment('SEED_MODERATOR_PASSWORD'),
      role: UserRole.MODERATOR,
    },
    {
      name: 'Development User',
      email: getRequiredEnvironment('SEED_USER_EMAIL').toLowerCase(),
      password: getRequiredEnvironment('SEED_USER_PASSWORD'),
      role: UserRole.USER,
    },
  ];
}

async function seed(): Promise<void> {
  const environment = process.env.NODE_ENV;
  if (environment !== 'development' && environment !== 'test') {
    throw new Error(
      'Seed data is permitted only when NODE_ENV is development or test',
    );
  }

  const uri = getRequiredEnvironment('MONGODB_URI');
  const accounts = getSeedAccounts();

  await connect(uri);
  const userModel = model(User.name, UserSchema);

  for (const account of accounts) {
    const password = await bcrypt.hash(account.password, 12);
    await userModel.updateOne(
      { email: account.email.toLowerCase() },
      {
        $setOnInsert: {
          name: account.name,
          email: account.email.toLowerCase(),
          password,
          role: account.role,
          termsAcceptedAt: new Date(),
          isActive: true,
          isSuspended: false,
          mustChangePassword: false,
          lastActivityAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  console.log(
    `Seed complete: ensured ${accounts.length} development accounts`,
  );
}

seed()
  .catch((error: unknown) => {
    console.error(
      'Seed failed:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await disconnect();
    } catch (error: unknown) {
      console.error(
        'Seed cleanup failed:',
        error instanceof Error ? error.message : 'Unknown database error',
      );
      process.exitCode = 1;
    }
  });