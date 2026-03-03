'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Mail, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { isAuthenticated } from '@/lib/auth';
import { login } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/dashboard');
    }
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login({ email, password });
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Email ou senha incorretos');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #0a1628 0%, #0d2137 50%, #0f2b46 100%)' }}
    >
      <div
        className="w-full sm:p-10 p-8 sm:px-10 px-6 rounded-2xl border"
        style={{
          maxWidth: '420px',
          background: 'rgba(13, 33, 55, 0.8)',
          borderColor: 'rgba(56, 189, 248, 0.15)',
          boxShadow: '0 0 40px rgba(56, 189, 248, 0.08)',
        }}
      >
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <Image
            src="/iconsai-logo-official.png"
            alt="IconsAI"
            width={140}
            height={140}
            style={{ maxWidth: '160px', height: 'auto' }}
            className="object-contain"
          />
        </div>

        {/* Titulo */}
        <h1
          className="text-2xl sm:text-3xl font-bold text-center mb-2"
          style={{ color: '#38bdf8' }}
        >
          Scraping Hub
        </h1>

        {/* Subtitulo */}
        <p
          className="text-sm text-center mb-8"
          style={{ color: '#64748b' }}
        >
          Business Intelligence Brasil
        </p>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div className="space-y-2">
            <label className="text-sm font-medium" style={{ color: '#e2e8f0' }}>
              Email
            </label>
            <div className="relative">
              <Mail
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                style={{ color: '#64748b' }}
              />
              <input
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full h-12 pl-11 pr-4 rounded-[10px] text-sm transition-colors duration-200"
                style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(100, 116, 139, 0.3)',
                  color: '#e2e8f0',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'rgba(56, 189, 248, 0.6)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(56, 189, 248, 0.1)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(100, 116, 139, 0.3)';
                  e.target.style.boxShadow = 'none';
                }}
              />
            </div>
          </div>

          {/* Senha */}
          <div className="space-y-2">
            <label className="text-sm font-medium" style={{ color: '#e2e8f0' }}>
              Senha
            </label>
            <div className="relative">
              <Lock
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5"
                style={{ color: '#64748b' }}
              />
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="********"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full h-12 pl-11 pr-11 rounded-[10px] text-sm transition-colors duration-200"
                style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(100, 116, 139, 0.3)',
                  color: '#e2e8f0',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'rgba(56, 189, 248, 0.6)';
                  e.target.style.boxShadow = '0 0 0 3px rgba(56, 189, 248, 0.1)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'rgba(100, 116, 139, 0.3)';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                style={{ color: '#64748b' }}
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? (
                  <EyeOff className="w-5 h-5" />
                ) : (
                  <Eye className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          {/* Botao Entrar */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
            style={{
              background: 'linear-gradient(135deg, #0e4a6f, #1a6b8a)',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              color: '#e2e8f0',
              boxSizing: 'border-box',
              marginTop: '20px',
            }}
            onMouseEnter={(e) => {
              if (!loading) {
                e.currentTarget.style.background = 'linear-gradient(135deg, #1a6b8a, #2080a0)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(56, 189, 248, 0.15)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, #0e4a6f, #1a6b8a)';
              e.currentTarget.style.boxShadow = 'none';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Entrando...
              </>
            ) : (
              'Entrar'
            )}
          </button>
        </form>

        {/* Esqueci minha senha - CENTRALIZADO */}
        <div className="text-center mt-5">
          <a
            href="/recover-password"
            className="text-sm hover:underline transition-colors"
            style={{ color: '#38bdf8' }}
          >
            Esqueci minha senha
          </a>
        </div>

        {/* Rodape */}
        <div className="text-center mt-8">
          <p className="text-xs" style={{ color: '#64748b' }}>
            Business Intelligence Brasil
          </p>
          <p className="text-xs" style={{ color: 'rgba(100, 116, 139, 0.6)' }}>
            Iconsai - Todos os direitos reservados
          </p>
        </div>
      </div>
    </div>
  );
}
