import { NextRequest, NextResponse } from 'next/server';

const NODEJS_API_URL = process.env.NODEJS_API_URL || 'http://localhost:3006';

const FALLBACK_RESPONSE = {
  success: false,
  stats: [],
  data_referencia: new Date().toISOString().split('T')[0],
  online: false,
  proxima_atualizacao_segundos: 30,
  timestamp: new Date().toISOString(),
  error: 'Backend indisponivel',
};

export async function GET(request: NextRequest) {
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

    const response = await fetch(`${NODEJS_API_URL}/stats/current`, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return NextResponse.json(FALLBACK_RESPONSE, { status: 200 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(FALLBACK_RESPONSE, { status: 200 });
  }
}
