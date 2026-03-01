import { NextRequest, NextResponse } from 'next/server';

const NODEJS_API_URL = process.env.NODEJS_API_URL || 'http://localhost:3006';

export async function POST(request: NextRequest) {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(`${NODEJS_API_URL}/stats/snapshot`, {
      method: 'POST',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: 'Backend indisponivel' },
        { status: 200 }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Backend indisponivel' },
      { status: 200 }
    );
  }
}
