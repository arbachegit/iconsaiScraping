import { NextResponse } from 'next/server';

const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:8000';

export async function GET() {
  try {
    const response = await fetch(`${PYTHON_API_URL}/api/stats/current`, {
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: 'Failed to fetch stats' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json(
      {
        success: false,
        stats: [],
        data_referencia: new Date().toISOString(),
        online: false,
        error: 'API unavailable',
      },
      { status: 500 }
    );
  }
}
