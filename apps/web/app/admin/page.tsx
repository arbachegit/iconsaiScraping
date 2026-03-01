'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Shield,
  ShieldCheck,
  Crown,
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
  Trash2,
  Building2,
  Users,
  Landmark,
  ScrollText,
  Receipt,
  Newspaper,
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
  adminPermanentDeleteUser,
  type AdminUser,
  type AdminCreateUserRequest,
  type AdminCreateUserFlowRequest,
  type AdminUpdateUserRequest,
} from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { ALL_PERMISSIONS, PERMISSION_INFO, ROLE_INFO, ROLES, isSuperAdmin, isAdminRole, type Permission, type Role } from '@/lib/permissions';

type CreateMode = 'password' | 'invite';
type Tab = 'ativos' | 'inativos';

export default function AdminPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('ativos');

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
    // Redirect non-admin users back to dashboard
    if (userQuery.data && !userQuery.data.is_admin) {
      router.push('/dashboard');
    }
  }, [userQuery.isError, userQuery.data, router]);

  // Users list
  const usersQuery = useQuery({
    queryKey: ['admin-users'],
    queryFn: adminListUsers,
    enabled: !!userQuery.data,
  });

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<AdminUser | null>(null);
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState<AdminUser | null>(null);

  // Loading guard
  if (userQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />
      </div>
    );
  }

  if (!userQuery.data) {
    return null;
  }

  const currentUserRole = userQuery.data.role || 'user';
  const currentIsSuperAdmin = isSuperAdmin(currentUserRole);

  const allUsers = usersQuery.data?.users || [];
  const activeUsers = allUsers.filter((u) => u.is_active);
  const inactiveUsers = allUsers.filter((u) => !u.is_active);
  const displayedUsers = activeTab === 'ativos' ? activeUsers : inactiveUsers;

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
            <span className="font-semibold">{allUsers.length}</span>
            <span>usuarios cadastrados</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-400">
            <span className="font-semibold">{activeUsers.length}</span>
            <span>ativos</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
            <span className="font-semibold">{inactiveUsers.length}</span>
            <span>inativos</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex mb-4 border-b border-white/5">
          <button
            onClick={() => setActiveTab('ativos')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'ativos'
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Ativos
            <span className="ml-1.5 text-xs opacity-70">({activeUsers.length})</span>
            {activeTab === 'ativos' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('inativos')}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'inativos'
                ? 'text-cyan-400'
                : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Inativos
            <span className="ml-1.5 text-xs opacity-70">({inactiveUsers.length})</span>
            {activeTab === 'inativos' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />
            )}
          </button>
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
                    CPF
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Telefone
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Endereco
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Permissoes
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Acoes
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedUsers.map((user) => (
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
                        {user.cpf || '-'}
                      </span>
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
                      {(() => {
                        const role = (user.role || 'user') as Role;
                        const info = ROLE_INFO[role] || ROLE_INFO.user;
                        const iconMap: Record<string, React.ReactNode> = {
                          superadmin: <Crown className="h-4 w-4 text-red-400" />,
                          admin: <ShieldCheck className="h-4 w-4 text-amber-400" />,
                          user: <User className="h-4 w-4 text-blue-400" />,
                        };
                        return (
                          <div className="flex items-center gap-1.5" title={info.description}>
                            {iconMap[role] || iconMap.user}
                            <span className="text-xs text-slate-300">{info.label}</span>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
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
                      <div className="flex items-center gap-1.5">
                        {(user.permissions || []).length > 0 ? (
                          (user.permissions || []).map((perm) => {
                            const info = PERMISSION_INFO[perm as Permission];
                            if (!info) return null;
                            const colorMap: Record<string, string> = {
                              red: 'text-red-400',
                              orange: 'text-orange-400',
                              blue: 'text-blue-400',
                              purple: 'text-purple-400',
                              cyan: 'text-cyan-400',
                              green: 'text-green-400',
                            };
                            const iconMap: Record<string, React.ReactNode> = {
                              empresas: <Building2 className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                              pessoas: <Users className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                              politicos: <Landmark className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                              mandatos: <ScrollText className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                              emendas: <Receipt className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                              noticias: <Newspaper className={`h-3.5 w-3.5 ${colorMap[info.color]}`} />,
                            };
                            return (
                              <span key={perm} title={`${info.label}: ${info.description}`}>
                                {iconMap[perm]}
                              </span>
                            );
                          })
                        ) : (
                          <span className="text-[10px] text-slate-500">Nenhuma</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        {!user.is_verified && (
                          <ResendInviteButton userId={user.id} queryClient={queryClient} />
                        )}
                        {currentIsSuperAdmin && user.role !== 'superadmin' && (
                          <button
                            onClick={() => setEditingUser(user)}
                            className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-400 transition-colors"
                            title="Editar"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {currentIsSuperAdmin && user.role !== 'superadmin' && (
                          user.is_active ? (
                            <button
                              onClick={() => setConfirmDeactivate(user)}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                              title="Desativar"
                            >
                              <UserX className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <>
                              <ReactivateButton userId={user.id} queryClient={queryClient} />
                              <button
                                onClick={() => setConfirmPermanentDelete(user)}
                                className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                                title="Excluir permanentemente"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {displayedUsers.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-sm text-slate-400">
                      {activeTab === 'ativos'
                        ? 'Nenhum usuario ativo.'
                        : 'Nenhum usuario inativo.'}
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
          currentUserRole={currentUserRole}
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

      {/* Confirm Permanent Delete Modal */}
      {confirmPermanentDelete && (
        <ConfirmPermanentDeleteModal
          user={confirmPermanentDelete}
          onClose={() => setConfirmPermanentDelete(null)}
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
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => adminResendInvite(userId),
    onSuccess: () => {
      setSent(true);
      setError('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  if (sent) {
    return (
      <span className="inline-flex items-center justify-center h-8 px-2 rounded-lg text-green-400 text-[11px]">
        Enviado
      </span>
    );
  }

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 h-8 px-2 rounded-lg text-red-400 text-[11px]" title={error}>
        Falha
        <button
          onClick={() => { setError(''); mutation.mutate(); }}
          className="ml-1 text-amber-400 hover:text-amber-300 underline"
        >
          Tentar
        </button>
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
  currentUserRole,
}: {
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserRole: string;
}) {
  const canCreateWithPassword = isSuperAdmin(currentUserRole);
  const [mode, setMode] = useState<CreateMode>('invite');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [selectedRole, setSelectedRole] = useState<string>('user');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  function togglePermission(perm: string) {
    setPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    );
  }

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
        permissions: selectedRole === 'admin' ? ['empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias'] : permissions,
        role: selectedRole,
      });
    } else {
      createWithInviteMutation.mutate({
        name,
        email,
        phone,
        role: selectedRole,
        permissions: selectedRole === 'admin'
          ? ['empresas', 'pessoas', 'politicos', 'mandatos', 'emendas', 'noticias']
          : permissions,
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
            {canCreateWithPassword && (
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
            )}
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

          {/* Phone (required for invite mode) */}
          {mode === 'invite' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">
                Telefone <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+55 11 99999-0000"
                  className="pl-10 h-10"
                  required
                />
              </div>
              <p className="text-[10px] text-slate-500">WhatsApp + SMS serao enviados para este numero</p>
            </div>
          )}

          {/* Role (superadmin only, both modes) */}
          {canCreateWithPassword && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Role</label>
              <div className="grid grid-cols-2 gap-2">
                {(['admin', 'user'] as const).map((role) => {
                  const info = ROLE_INFO[role];
                  const colorMap: Record<string, string> = {
                    amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
                    blue: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
                  };
                  return (
                    <label
                      key={role}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        selectedRole === role
                          ? colorMap[info.color] || 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                          : 'bg-[#0a0e1a] border-white/5 text-slate-400 hover:border-white/10'
                      }`}
                    >
                      <input
                        type="radio"
                        name="role"
                        checked={selectedRole === role}
                        onChange={() => setSelectedRole(role)}
                        className="sr-only"
                      />
                      <div className="min-w-0">
                        <span className="text-xs font-medium">{info.label}</span>
                        <p className="text-[10px] opacity-70">{info.description}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Permissions (only for role=user) */}
          {selectedRole === 'user' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Permissoes</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ALL_PERMISSIONS.map((perm) => {
                const info = PERMISSION_INFO[perm as Permission];
                const permIconMap: Record<string, React.ReactNode> = {
                  empresas: <Building2 className="h-3.5 w-3.5" />,
                  pessoas: <Users className="h-3.5 w-3.5" />,
                  politicos: <Landmark className="h-3.5 w-3.5" />,
                  mandatos: <ScrollText className="h-3.5 w-3.5" />,
                  emendas: <Receipt className="h-3.5 w-3.5" />,
                  noticias: <Newspaper className="h-3.5 w-3.5" />,
                };
                return (
                <label
                  key={perm}
                  className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border cursor-pointer transition-colors ${
                    permissions.includes(perm)
                      ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                      : 'bg-[#0a0e1a] border-white/5 text-slate-400 hover:border-white/10'
                  }`}
                  title={info.description}
                >
                  <input
                    type="checkbox"
                    checked={permissions.includes(perm)}
                    onChange={() => togglePermission(perm)}
                    className="sr-only"
                  />
                  {permIconMap[perm]}
                  <span className="text-[10px] font-medium">{info.label}</span>
                </label>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500">
              Selecione os modulos que o usuario podera acessar
            </p>
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
  const [editName, setEditName] = useState(user.name || '');
  const [editEmail, setEditEmail] = useState(user.email || '');
  const [editPhone, setEditPhone] = useState(user.phone || '');
  const [editCpf, setEditCpf] = useState(user.cpf || '');
  const [editCep, setEditCep] = useState(user.cep || '');
  const [editLogradouro, setEditLogradouro] = useState(user.logradouro || '');
  const [editNumero, setEditNumero] = useState(user.numero || '');
  const [editComplemento, setEditComplemento] = useState(user.complemento || '');
  const [editBairro, setEditBairro] = useState(user.bairro || '');
  const [editCidade, setEditCidade] = useState(user.cidade || '');
  const [editUf, setEditUf] = useState(user.uf || '');
  const [editRole, setEditRole] = useState(user.role || 'user');
  const [editPermissions, setEditPermissions] = useState<string[]>(user.permissions || []);
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  function toggleEditPermission(perm: string) {
    setEditPermissions((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]
    );
  }

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
    if (editName !== (user.name || '')) updates.name = editName;
    if (editEmail !== (user.email || '')) updates.email = editEmail;
    if (editPhone !== (user.phone || '')) updates.phone = editPhone;
    if (editCpf !== (user.cpf || '')) updates.cpf = editCpf;
    if (editCep !== (user.cep || '')) updates.cep = editCep;
    if (editLogradouro !== (user.logradouro || '')) updates.logradouro = editLogradouro;
    if (editNumero !== (user.numero || '')) updates.numero = editNumero;
    if (editComplemento !== (user.complemento || '')) updates.complemento = editComplemento;
    if (editBairro !== (user.bairro || '')) updates.bairro = editBairro;
    if (editCidade !== (user.cidade || '')) updates.cidade = editCidade;
    if (editUf !== (user.uf || '')) updates.uf = editUf;
    if (editRole !== (user.role || 'user')) updates.role = editRole;
    if (newPassword) updates.new_password = newPassword;

    // Check if permissions changed
    const prevPerms = [...(user.permissions || [])].sort().join(',');
    const newPerms = [...editPermissions].sort().join(',');
    if (prevPerms !== newPerms) updates.permissions = editPermissions;

    if (Object.keys(updates).length === 0) {
      setError('Nenhuma alteracao para salvar.');
      return;
    }

    mutation.mutate(updates);
  }

  const roleInfo = ROLE_INFO[(user.role || 'user') as Role] || ROLE_INFO.user;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0f1629] border border-white/10 rounded-xl w-full max-w-lg mx-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 sticky top-0 bg-[#0f1629] z-10">
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
            <div className="flex items-center gap-1" title={roleInfo.description}>
              {(user.role || 'user') === 'superadmin' ? <Crown className="h-4 w-4 text-red-400" /> :
               (user.role || 'user') === 'admin' ? <ShieldCheck className="h-4 w-4 text-amber-400" /> :
               <User className="h-4 w-4 text-blue-400" />}
              <span className="text-[10px] text-slate-400">{roleInfo.label}</span>
            </div>
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

          {/* Dados Pessoais */}
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider pt-1">Dados Pessoais</p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-slate-300">Nome</label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Nome completo" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Email</label>
              <Input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="email@email.com" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Telefone</label>
              <Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="+55 11 99999-0000" className="h-9 text-sm" />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-slate-300">CPF</label>
              <Input value={editCpf} onChange={(e) => setEditCpf(e.target.value)} placeholder="000.000.000-00" className="h-9 text-sm" />
            </div>
          </div>

          {/* Endereco */}
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider pt-2">Endereco</p>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">CEP</label>
              <Input value={editCep} onChange={(e) => setEditCep(e.target.value)} placeholder="00000-000" className="h-9 text-sm" />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-slate-300">Logradouro</label>
              <Input value={editLogradouro} onChange={(e) => setEditLogradouro(e.target.value)} placeholder="Rua, Av..." className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Numero</label>
              <Input value={editNumero} onChange={(e) => setEditNumero(e.target.value)} placeholder="123" className="h-9 text-sm" />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-slate-300">Complemento</label>
              <Input value={editComplemento} onChange={(e) => setEditComplemento(e.target.value)} placeholder="Apto, Sala..." className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Bairro</label>
              <Input value={editBairro} onChange={(e) => setEditBairro(e.target.value)} placeholder="Bairro" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">Cidade</label>
              <Input value={editCidade} onChange={(e) => setEditCidade(e.target.value)} placeholder="Cidade" className="h-9 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">UF</label>
              <Input value={editUf} onChange={(e) => setEditUf(e.target.value)} placeholder="SP" maxLength={2} className="h-9 text-sm" />
            </div>
          </div>

          {/* Acesso */}
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider pt-2">Acesso</p>

          {/* Role */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {(['admin', 'user'] as const).map((role) => {
                const info = ROLE_INFO[role];
                const colorMap: Record<string, string> = {
                  amber: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
                  blue: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
                };
                return (
                  <label
                    key={role}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      editRole === role
                        ? colorMap[info.color] || 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                        : 'bg-[#0a0e1a] border-white/5 text-slate-400 hover:border-white/10'
                    }`}
                  >
                    <input
                      type="radio"
                      name="editRole"
                      checked={editRole === role}
                      onChange={() => setEditRole(role)}
                      className="sr-only"
                    />
                    <div className="min-w-0">
                      <span className="text-xs font-medium">{info.label}</span>
                      <p className="text-[10px] opacity-70">{info.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Permissions (only for role=user) */}
          {editRole === 'user' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300">Permissoes</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ALL_PERMISSIONS.map((perm) => {
                const info = PERMISSION_INFO[perm as Permission];
                const permIconMap: Record<string, React.ReactNode> = {
                  empresas: <Building2 className="h-3.5 w-3.5" />,
                  pessoas: <Users className="h-3.5 w-3.5" />,
                  politicos: <Landmark className="h-3.5 w-3.5" />,
                  mandatos: <ScrollText className="h-3.5 w-3.5" />,
                  emendas: <Receipt className="h-3.5 w-3.5" />,
                  noticias: <Newspaper className="h-3.5 w-3.5" />,
                };
                return (
                <label
                  key={perm}
                  className={`flex flex-col items-center gap-1 px-2 py-2 rounded-lg border cursor-pointer transition-colors ${
                    editPermissions.includes(perm)
                      ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                      : 'bg-[#0a0e1a] border-white/5 text-slate-400 hover:border-white/10'
                  }`}
                  title={info.description}
                >
                  <input
                    type="checkbox"
                    checked={editPermissions.includes(perm)}
                    onChange={() => toggleEditPermission(perm)}
                    className="sr-only"
                  />
                  {permIconMap[perm]}
                  <span className="text-[10px] font-medium">{info.label}</span>
                </label>
                );
              })}
            </div>
          </div>
          )}

          {editRole === 'admin' && (
            <p className="text-[10px] text-amber-400/70">Admins tem acesso a todos os modulos automaticamente.</p>
          )}

          {/* Senha */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-300">
              Nova Senha <span className="text-slate-500">(deixe vazio para manter)</span>
            </label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Nova senha (opcional)"
              className="h-9 text-sm"
              minLength={6}
            />
          </div>

          {/* Submit */}
          <div className="pt-2 pb-1">
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
            O usuario nao podera mais fazer login. Ele sera movido para a aba Inativos.
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

// ===========================================
// Confirm Permanent Delete Modal
// ===========================================

function ConfirmPermanentDeleteModal({
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
    mutationFn: () => adminPermanentDeleteUser(user.id),
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
            <Trash2 className="h-4 w-4 text-red-400" />
            <h2 className="text-sm font-semibold text-slate-100">Excluir Permanentemente</h2>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          <p className="text-sm text-slate-300">
            Deseja excluir permanentemente o usuario <strong className="text-slate-100">{user.name || user.email}</strong>?
          </p>
          <p className="text-xs text-red-400 font-medium">
            Esta acao NAO pode ser revertida. O usuario sera removido do banco de dados.
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
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Excluir
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
