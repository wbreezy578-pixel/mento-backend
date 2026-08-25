import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    { error: 'Direct plan changes are disabled. Use the subscription management portal instead.', code: 'MANAGE_SUBSCRIPTION_REQUIRED' },
    { status: 410 },
  );
}
