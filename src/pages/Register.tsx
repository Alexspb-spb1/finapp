import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { TrendingUp, Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react'
import { authStore } from '../store/authStore'

type Step = 'account' | 'company'

export default function Register() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('account')

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [showPass, setShowPass] = useState(false)

  const [companyName, setCompanyName] = useState('')
  const [legalType, setLegalType] = useState<'ooo' | 'ip'>('ooo')
  const [inn, setInn] = useState('')

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const passwordStrength = (() => {
    if (password.length === 0) return 0
    let score = 0
    if (password.length >= 8) score++
    if (/[A-Z]/.test(password)) score++
    if (/[0-9]/.test(password)) score++
    if (/[^A-Za-z0-9]/.test(password)) score++
    return score
  })()

  const strengthColor = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-emerald-500'][passwordStrength - 1] ?? 'bg-slate-600'
  const strengthLabel = ['', 'Слабый', 'Средний', 'Хороший', 'Отличный'][passwordStrength]

  function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== password2) { setError('Пароли не совпадают'); return }
    if (password.length < 6) { setError('Пароль должен быть не менее 6 символов'); return }
    setStep('company')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await authStore.register({ name, email, password, companyName, legalType, inn: inn || undefined })
    setLoading(false)

    if (result.ok) {
      navigate('/', { replace: true })
    } else if (result.error === 'email_taken') {
      setStep('account')
      setError('Пользователь с таким email уже существует')
    } else {
      setError('Ошибка регистрации. Попробуйте ещё раз.')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-indigo-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-purple-600/20 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-md relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600 shadow-lg shadow-indigo-500/30 mb-4">
            <TrendingUp size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">ФинУчёт</h1>
          <p className="text-slate-400 text-sm mt-1">Управленческий учёт для бизнеса</p>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-3 mb-6 px-2">
          {(['account', 'company'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-3 flex-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                step === s ? 'bg-indigo-600 text-white ring-2 ring-indigo-400/40'
                : i < (['account', 'company'] as Step[]).indexOf(step) ? 'bg-emerald-500 text-white'
                : 'bg-white/10 text-slate-400'
              }`}>
                {i < (['account', 'company'] as Step[]).indexOf(step) ? <CheckCircle2 size={14} /> : i + 1}
              </div>
              <span className={`text-xs font-medium ${step === s ? 'text-white' : 'text-slate-500'}`}>
                {s === 'account' ? 'Личные данные' : 'Компания'}
              </span>
              {i < 1 && <div className="flex-1 h-px bg-white/10" />}
            </div>
          ))}
        </div>

        <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl">
          {step === 'account' ? (
            <>
              <h2 className="text-lg font-semibold text-white mb-1">Создать аккаунт</h2>
              <p className="text-slate-400 text-sm mb-6">Шаг 1 из 2 — данные пользователя</p>

              <form onSubmit={handleStep1} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Ваше имя</label>
                  <input
                    value={name} onChange={e => setName(e.target.value)}
                    placeholder="Иван Иванов" required
                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@company.ru" required autoComplete="email"
                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Пароль</label>
                  <div className="relative">
                    <input
                      type={showPass ? 'text' : 'password'} value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Минимум 6 символов" required autoComplete="new-password"
                      className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 pr-11 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition"
                    />
                    <button type="button" onClick={() => setShowPass(!showPass)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200">
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {password.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="flex gap-1">
                        {[1,2,3,4].map(i => (
                          <div key={i} className={`h-1 flex-1 rounded-full transition-all ${i <= passwordStrength ? strengthColor : 'bg-white/10'}`} />
                        ))}
                      </div>
                      <p className="text-xs text-slate-400">{strengthLabel}</p>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Повторите пароль</label>
                  <input
                    type="password" value={password2} onChange={e => setPassword2(e.target.value)}
                    placeholder="••••••••" required autoComplete="new-password"
                    className={`w-full bg-white/10 border rounded-xl px-4 py-3 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition ${
                      password2 && password !== password2 ? 'border-red-500/50' : 'border-white/10'
                    }`}
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-4 py-3 text-sm">
                    <AlertCircle size={16} className="shrink-0" /> {error}
                  </div>
                )}

                <button type="submit"
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-3 rounded-xl transition-colors mt-2">
                  Далее →
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-white mb-1">Данные компании</h2>
              <p className="text-slate-400 text-sm mb-6">Шаг 2 из 2 — создание организации</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Legal type toggle */}
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">Форма организации</label>
                  <div className="flex rounded-xl overflow-hidden border border-white/10">
                    {(['ooo', 'ip'] as const).map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setLegalType(t)}
                        className={`flex-1 py-3 text-sm font-semibold transition-all ${
                          legalType === t
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white/5 text-slate-400 hover:bg-white/10'
                        }`}
                      >
                        {t === 'ooo' ? 'ООО' : 'ИП'}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {legalType === 'ooo' ? 'Общество с ограниченной ответственностью' : 'Индивидуальный предприниматель'}
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    {legalType === 'ooo' ? 'Название компании' : 'ФИО предпринимателя'}
                  </label>
                  <input
                    value={companyName} onChange={e => setCompanyName(e.target.value)}
                    placeholder={legalType === 'ooo' ? 'Моя Компания' : 'Иванов Иван Иванович'} required
                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1.5">
                    ИНН <span className="text-slate-500">(необязательно · {legalType === 'ooo' ? '10 цифр' : '12 цифр'})</span>
                  </label>
                  <input
                    value={inn} onChange={e => setInn(e.target.value)}
                    placeholder={legalType === 'ooo' ? '7701234567' : '770112345678'}
                    maxLength={legalType === 'ooo' ? 10 : 12}
                    className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-slate-500 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition"
                  />
                </div>

                <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 space-y-1">
                  <p className="text-xs font-medium text-indigo-300">Данные аккаунта</p>
                  <p className="text-sm text-slate-300">{name} · {email}</p>
                  <p className="text-xs text-slate-500">Роль: Администратор · {legalType === 'ooo' ? 'ООО' : 'ИП'}</p>
                </div>

                {error && (
                  <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-4 py-3 text-sm">
                    <AlertCircle size={16} className="shrink-0" /> {error}
                  </div>
                )}

                <div className="flex gap-3">
                  <button type="button" onClick={() => setStep('account')}
                    className="flex-1 border border-white/10 text-slate-300 hover:bg-white/5 font-medium py-3 rounded-xl transition-colors">
                    ← Назад
                  </button>
                  <button type="submit" disabled={loading}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                    {loading && (
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    )}
                    {loading ? 'Создаём...' : 'Создать аккаунт'}
                  </button>
                </div>
              </form>
            </>
          )}

          <p className="text-center text-sm text-slate-400 mt-6">
            Уже есть аккаунт?{' '}
            <Link to="/login" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
              Войти
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
