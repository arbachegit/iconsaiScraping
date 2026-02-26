'use client';

import { Suspense, useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from '@/components/ui/card';
import { verifyCode, resendCode } from '@/lib/api';

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyContent />
    </Suspense>
  );
}

function VerifyContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') || '';

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  async function handleResend() {
    if (!email || resending || resendCooldown > 0) return;
    setResending(true);
    setError('');
    try {
      await resendCode(email);
      setResendCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao reenviar codigo');
    } finally {
      setResending(false);
    }
  }

  function handleDigitChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;

    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);

    // Auto-focus next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pastedText.length === 6) {
      setDigits(pastedText.split(''));
      inputRefs.current[5]?.focus();
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const code = digits.join('');
    if (code.length !== 6) {
      setError('Digite o codigo completo de 6 digitos.');
      return;
    }

    if (!email) {
      setError('Email nao encontrado. Tente novamente.');
      return;
    }

    setLoading(true);
    try {
      await verifyCode(email, code);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Codigo invalido');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-grid bg-glow relative overflow-hidden">
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-cyan-500/10 rounded-full blur-[100px]" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-blue-500/10 rounded-full blur-[100px]" />

      <Card className="w-full max-w-md relative z-10">
        <CardHeader className="text-center">
          <div className="flex flex-col items-center">
            <Image src="/iconsai-logo.png" alt="Iconsai" width={180} height={64} className="h-16 w-auto mb-4" />
            {success ? (
              <>
                <CheckCircle2 className="h-12 w-12 text-green-400 mb-2" />
                <CardTitle>Conta Ativada!</CardTitle>
                <CardDescription>Sua conta foi verificada com sucesso</CardDescription>
              </>
            ) : (
              <>
                <CardTitle>Verificar Conta</CardTitle>
                <CardDescription>
                  Digite o codigo de 6 digitos enviado para{' '}
                  {email ? <strong>{email}</strong> : 'seu email'}
                </CardDescription>
              </>
            )}
          </div>
        </CardHeader>

        <CardContent>
          {success ? (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm text-center">
                Conta ativada com sucesso! Voce ja pode fazer login.
              </div>
              <Button className="w-full" onClick={() => router.push('/')}>
                Fazer Login
              </Button>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="flex justify-center gap-2" onPaste={handlePaste}>
                  {digits.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => { inputRefs.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(i, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(i, e)}
                      className="w-12 h-14 text-center text-xl font-bold rounded-xl bg-[#1a2332] border border-white/10 text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
                    />
                  ))}
                </div>

                <Button type="submit" className="w-full" disabled={loading || digits.join('').length !== 6}>
                  {loading ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Verificando...
                    </>
                  ) : (
                    'Verificar Codigo'
                  )}
                </Button>

                <div className="text-center text-sm text-muted-foreground">
                  {resendCooldown > 0 ? (
                    <p>Reenviar codigo em {resendCooldown}s</p>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resending || !email}
                      className="text-cyan-400 hover:text-cyan-300 underline disabled:opacity-50 disabled:no-underline"
                    >
                      {resending ? 'Reenviando...' : 'Reenviar codigo'}
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </CardContent>

        <CardFooter className="flex-col text-center text-xs text-muted-foreground">
          <p>Business Intelligence Brasil</p>
          <p className="text-muted-foreground/60">Iconsai - Todos os direitos reservados</p>
        </CardFooter>
      </Card>
    </div>
  );
}
