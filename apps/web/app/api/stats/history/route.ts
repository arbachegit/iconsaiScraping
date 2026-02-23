import { NextRequest, NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = searchParams.get('limit') || '30';

    const response = await fetch(
      `${PYTHON_API_URL}/api/stats/history?limit=${limit}`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: 'Failed to fetch history' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching stats history:', error);
    return NextResponse.json(
      {
        success: false,
        historico: {},
        categorias: [],
        total_registros: 0,
        error: 'API unavailable',
      },
      { status: 500 }
    );
  }
}
