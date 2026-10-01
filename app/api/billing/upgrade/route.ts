import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Direct plan upgrades are disabled. Start a verified payment checkout instead.', code: 'PAYMENT_REQUIRED' },
    { status: 410 },
  );
}
