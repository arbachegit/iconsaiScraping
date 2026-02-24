import { NextResponse } from 'next/server';

const NODEJS_API_URL = process.env.NODEJS_API_URL || 'http://localhost:3001';

export async function POST() {
  try {
    const response = await fetch(`${NODEJS_API_URL}/stats/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: 'Failed to create snapshot' },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error creating stats snapshot:', error);
    return NextResponse.json(
      { success: false, error: 'API unavailable' },
      { status: 500 }
    );
  }
}
