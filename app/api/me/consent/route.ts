import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { prisma } from '../../../../lib/prisma';
import { CURRENT_LEGAL_VERSIONS } from '../../../../lib/legalVersions';
import { getUserFromRequest } from '../../../lib/auth';

export async function GET(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const records = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ConsentRecord"
    WHERE "userId" = ${user.id}
      AND "privacyVersion" = ${CURRENT_LEGAL_VERSIONS.privacy}
      AND "termsVersion" = ${CURRENT_LEGAL_VERSIONS.terms}
      AND "aiNoticeVersion" = ${CURRENT_LEGAL_VERSIONS.aiNotice}
      AND "revokedAt" IS NULL
    LIMIT 1
  `;

  return NextResponse.json({ accepted: records.length > 0, versions: CURRENT_LEGAL_VERSIONS });
}

export async function POST(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null) as { versions?: typeof CURRENT_LEGAL_VERSIONS; source?: unknown } | null;
  const versions = body?.versions;
  if (!versions || versions.privacy !== CURRENT_LEGAL_VERSIONS.privacy || versions.terms !== CURRENT_LEGAL_VERSIONS.terms || versions.aiNotice !== CURRENT_LEGAL_VERSIONS.aiNotice) {
    return NextResponse.json({ error: 'The legal notice has changed. Please review the current version.', versions: CURRENT_LEGAL_VERSIONS }, { status: 409 });
  }

  const source = body?.source === 'android' ? 'android' : 'mobile';
  const acceptedAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO "ConsentRecord" ("id", "userId", "privacyVersion", "termsVersion", "aiNoticeVersion", "source", "acceptedAt", "revokedAt")
    VALUES (${randomUUID()}, ${user.id}, ${versions.privacy}, ${versions.terms}, ${versions.aiNotice}, ${source}, ${acceptedAt}, NULL)
    ON CONFLICT ("userId", "privacyVersion", "termsVersion", "aiNoticeVersion")
    DO UPDATE SET "acceptedAt" = EXCLUDED."acceptedAt", "revokedAt" = NULL, "source" = EXCLUDED."source"
  `;

  return NextResponse.json({ accepted: true, acceptedAt, versions: CURRENT_LEGAL_VERSIONS });
}
