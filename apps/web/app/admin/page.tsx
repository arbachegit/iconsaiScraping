'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Shield,
  UserPlus,
  Pencil,
  UserX,
  UserCheck,
  Loader2,
  X,
  Mail,
  User,
  KeyRound,
  Phone,
  Send,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  getUser,
  adminListUsers,
  adminCreateUser,
  adminCreateUserFlow,
  adminUpdateUser,
  adminDeleteUser,
  adminResendInvite,
  type AdminUser,
  type AdminCreateUserRequest,
  type AdminCreateUserFlowRequest,
  type AdminUpdateUserRequest,
} from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';

type CreateMode = 'password' | 'invite';

export default function AdminPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Auth check
  const userQuery = useQuery({
    queryKey: ['user'],
    queryFn: getUser,
    retry: false,
  });

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
      return;
    }
  }, [router]);

  useEffect(() => {
    if (userQuery.isError) {
      router.push('/');
    }
    if (userQuery.data && !userQuery.data.is_admin) {
      router.push('/dashboard');
    }
  }, [userQuery.data, userQuery.isError, router]);

  // Users list
  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: adminListUsers,
    enabled: userQuery.data?.is_admin === true,
  });

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<AdminUser | null>(null);

  // Loading guard
  if (userQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (!userQuery.data || !userQuery.data.is_admin) {
    return null;
  }

  const users = usersQuery.data?.users || [];

  return (
    <div className="min-h-screen bg-[#0a0e1a]">
      {/* Header */}
      <header className="bg-[#0f1629]/80 backdrop-blur-xl border-b border-cyan-500/10">
        <div className="flex items-center justify-between px-4 lg:px-6 py-2.5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center gap-1.5 h-9 px-3 bg-slate-400/10 border border-slate-400/20 text-slate-300 rounded-lg text-xs font-medium hover:bg-slate-400/20 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Voltar</span>
            </button>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-cyan-400" />
              <h1 className="text-lg font-bold text-slate-100">
                Gestao de Usuarios
              </h1>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => setShowCreateModal(true)}
            className="gap-1.5"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Novo Usuario
          </Button>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 lg:px-6 py-6">
        {/* Stats bar */}
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-xs text-cyan-400">
            <span className="font-semibold">{users.length}</span>
            <span>usuarios cadastrados</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-400">
            <span className="font-semibold">{users.filter((u) => u.is_active).length}</span>
            <span>ativos</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
            <span className="font-semibold">{users.filter((u) => !u.is_active).length}</span>
            <span>inativos</span>
          </div>
        </div>

        {/* Users table */}
        {usersQuery.isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
          </div>
        ) : usersQuery.isError ? (
          <div className="text-center py-20">
            <p className="text-red-400 text-sm">Erro ao carregar usuarios</p>
            <button
              onClick={() => usersQuery.refetch()}
              className="mt-2 text-cyan-400 text-sm hover:underline"
            >
              Tentar novamente
            </button>
          </div>
        ) : (
          <div className="bg-[#0f1629]/80 border border-white/5 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Usuario
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Telefone
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Endereco
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Acoes
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-slate-200 truncate">
                          {user.name || '-'}
                        </span>
                        <span className="text-xs text-slate-400 truncate">{user.email}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-slate-300 whitespace-nowrap">
                        {user.phone || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {user.cep ? (
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm text-slate-300 truncate">
                            {user.logradouro}{user.numero ? `, ${user.numero}` : ''}{user.complemento ? ` - ${user.complemento}` : ''}
                          </span>
                          <span className="text-xs text-slate-400 truncate">
                            {user.bairro}{user.cidade ? ` - ${user.cidade}` : ''}{user.uf ? `/${user.uf}` : ''} - CEP {user.cep}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">Nao preenchido</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {user.is_active ? (
                          <Badge variant="success">Ativo</Badge>
                        ) : (
                          <Badge variant="destructive">Inativo</Badge>
                        )}
                        {!user.is_verified && (
                          <Badge variant="outline" className="text-amber-400 border-amber-400/30">
                            Pendente
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {!user.is_verified && (
                          <ResendInviteButton userId={user.id} queryClient={queryClient} />
                        )}
                        <button
                          onClick={() => setEditingUser(user)}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-400 transition-colors"
                          title="Editar"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        {user.is_active ? (
                          <button
                            onClick={() => setConfirmDeactivate(user)}
                            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                            title="Desativar"
                          >
                            <UserX className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <ReactivateButton userId={user.id} queryClient={queryClient} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-slate-400">
                      Nenhum usuario cadastrado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </main>

      {/* Create User Modal */}
      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          queryClient={queryClient}
        />
      )}

      {/* Edit User Modal */}
      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          queryClient={queryClient}
        />
      )}

      {/* Confirm Deactivate Modal */}
      {confirmDeactivate && (
        <ConfirmDeactivateModal
          user={confirmDeactivate}
          onClose={() => setConfirmDeactivate(null)}
          queryClient={queryClient}
        />
      )}
    </div>
  );
}

// ===========================================
// Reactivate Button
// ===========================================

function ReactivateButton({
  userId,
  queryClient,
}: {
  userId: number;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const mutation = useMutation({
    mutationFn: () => adminUpdateUser(userId, { is_active: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-green-500/10 hover:text-green-400 transition-colors disabled:opacity-50"
      title="Reativar"
    >
      {mutation.isPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <UserCheck className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// ===========================================
// Resend Invite Button
// ===========================================

function ResendInviteButton({
  userId,
  queryClient,
}: {
  userId: number;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [sent, setSent] = useState(false);

  const mutation = useMutation({
    mutationFn: () => adminResendInvite(userId),
    onSuccess: () => {
      setSent(true);
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  if (sent) {
    return (
      <span className="inline-flex items-center justify-center h-8 px-2 rounded-lg text-green-400 text-[11px]">
        Enviado
      </span>
    );
  }

  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-amber-500/10 hover:text-amber-400 transition-colors disabled:opacity-50"
      title="Reenviar Convite"
    >
      {mutation.isPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Send className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

// ===========================================
// Create User Modal
// ===========================================

function CreateUserModal({
  onClose,
  queryClient,
}: {
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [mode, setMode] = useState<CreateMode>('invite');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const createWithPasswordMutation = useMutation({
    mutationFn: (data: AdminCreateUserRequest) => adminCreateUser(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setSuccessMsg('Usuario criado com sucesso.');
      setTimeout(onClose, 1500);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const createWithInviteMutation = useMutation({
    mutationFn: (data: AdminCreateUserFlowRequest) => adminCreateUserFlow(data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setSuccessMsg(res.message);
      setTimeout(onClose, 2000);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const isLoading = createWithPasswordMutation.isPending || createWithInviteMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (mode === 'password') {
      createWithPasswordMutation.mutate({
        name,
        email,
        password,
        is_admin: isAdmin,
        permissions: [],
      });
    } else {
      createWithInviteMutation.mutate({
        name,
        email,
        phone: phone || undefined,
      });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0f1629] border border-white/10 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">Novo Usuario</h2>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Toggle */}
        <div className="px-5 pt-4">
          <div className="flex bg-[#0a0e1a] rounded-lg p-0.5 border border-white/5">
            <button
              onClick={() => setMode('invite')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors ${
                mode === 'invite'
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-300 border border-transparent'
              }`}
            >
              <Send className="h-3 w-3" />
              Convite por Email
            </button>
            <button
              onClick={() => setMode('password')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-medium transition-colors ${
                mode === 'password'
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                  : 'text-slate-400 hover:text-slate-300 border border-transparent'
              }`}
            >
              <KeyRound className="h-3 w-3" />
              Com Senha
            </button>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {mode === 'invite'
              ? 'O usuario recebera um email para definir sua senha e ativar a conta.'
              : 'Defina uma senha diretamente. O usuario ja podera fazer login.'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="p-2.5 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-xs">
              {successMsg}
            </div>
          )}

          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">Nome</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome completo"
                className="pl-10 h-10"
                required
                minLength={2}
              />
            </div>
          </div>

          {/* Email */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="usuario@email.com"
                className="pl-10 h-10"
                required
              />
            </div>
          </div>

          {/* Password (only for password mode) */}
          {mode === 'password' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Senha</label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimo 6 caracteres"
                  className="pl-10 h-10"
                  required
                  minLength={6}
                />
              </div>
            </div>
          )}

          {/* Phone (only for invite mode) */}
          {mode === 'invite' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">
                Telefone <span className="text-slate-500">(opcional)</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(00) 00000-0000"
                  className="pl-10 h-10"
                />
              </div>
            </div>
          )}

          {/* Admin toggle (only for password mode) */}
          {mode === 'password' && (
            <div className="flex items-center gap-3">
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAdmin}
                  onChange={(e) => setIsAdmin(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-slate-600 rounded-full peer peer-checked:bg-cyan-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
              </label>
              <span className="text-xs font-medium text-slate-300">Administrador</span>
            </div>
          )}

          {/* Submit */}
          <div className="pt-2">
            <Button type="submit" className="w-full gap-1.5" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Criando...
                </>
              ) : mode === 'invite' ? (
                <>
                  <Send className="h-4 w-4" />
                  Enviar Convite
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  Criar Usuario
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ===========================================
// Edit User Modal
// ===========================================

function EditUserModal({
  user,
  onClose,
  queryClient,
}: {
  user: AdminUser;
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [name, setName] = useState(user.name || '');
  const [isAdmin, setIsAdmin] = useState(user.is_admin);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const mutation = useMutation({
    mutationFn: (data: AdminUpdateUserRequest) => adminUpdateUser(user.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setSuccessMsg('Usuario atualizado com sucesso.');
      setTimeout(onClose, 1500);
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    const updates: AdminUpdateUserRequest = {};
    if (name !== (user.name || '')) updates.name = name;
    if (isAdmin !== user.is_admin) updates.is_admin = isAdmin;
    if (newPassword) updates.new_password = newPassword;

    if (Object.keys(updates).length === 0) {
      setError('Nenhuma alteracao para salvar.');
      return;
    }

    mutation.mutate(updates);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0f1629] border border-white/10 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">Editar Usuario</h2>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* User info */}
        <div className="px-5 pt-4">
          <div className="flex items-center gap-3 p-3 bg-[#0a0e1a] rounded-lg border border-white/5">
            <div className="h-10 w-10 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-400 font-semibold text-sm">
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-200 truncate">{user.name || '-'}</p>
              <p className="text-xs text-slate-400 truncate">{user.email}</p>
            </div>
            <Badge variant={user.is_admin ? 'default' : 'outline'} className="flex-shrink-0">
              {user.is_admin ? 'Admin' : 'Usuario'}
            </Badge>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3">
          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="p-2.5 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-xs">
              {successMsg}
            </div>
          )}

          {/* Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">Nome</label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome completo"
                className="pl-10 h-10"
                minLength={2}
              />
            </div>
          </div>

          {/* Admin toggle */}
          <div className="flex items-center gap-3">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isAdmin}
                onChange={(e) => setIsAdmin(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-600 rounded-full peer peer-checked:bg-cyan-500 transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
            </label>
            <span className="text-xs font-medium text-slate-300">Administrador</span>
          </div>

          {/* New Password */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">
              Nova Senha <span className="text-slate-500">(deixe vazio para manter)</span>
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Nova senha (opcional)"
                className="pl-10 h-10"
                minLength={6}
              />
            </div>
          </div>

          {/* Submit */}
          <div className="pt-2">
            <Button type="submit" className="w-full gap-1.5" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4" />
                  Salvar Alteracoes
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ===========================================
// Confirm Deactivate Modal
// ===========================================

function ConfirmDeactivateModal({
  user,
  onClose,
  queryClient,
}: {
  user: AdminUser;
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => adminDeleteUser(user.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0f1629] border border-white/10 rounded-xl w-full max-w-sm mx-4 shadow-2xl">
        <div className="px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2">
            <UserX className="h-4 w-4 text-red-400" />
            <h2 className="text-sm font-semibold text-slate-100">Desativar Usuario</h2>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          <p className="text-sm text-slate-300">
            Deseja desativar o usuario <strong className="text-slate-100">{user.name || user.email}</strong>?
          </p>
          <p className="text-xs text-slate-400">
            O usuario nao podera mais fazer login. Esta acao pode ser revertida.
          </p>

          <div className="flex items-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              className="flex-1"
              disabled={mutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => mutation.mutate()}
              className="flex-1 gap-1.5"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserX className="h-3.5 w-3.5" />
              )}
              Desativar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
