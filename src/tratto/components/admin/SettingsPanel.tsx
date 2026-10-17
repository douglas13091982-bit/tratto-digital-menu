// @ts-nocheck -- código original migrado sem alterações de lógica
import { useEffect, useState } from 'react'
import PasswordInput from '../PasswordInput'
import { errorPt } from '@/lib/errors-pt'
import { CheckCircle2, Store, Clock3, Truck, Eye, ShieldCheck, AlertTriangle, MapPin, Phone, Tag, Volume2, Play, Music, Printer } from 'lucide-react'
import { useStore } from '../../context/StoreContext'
import { supabase } from '@/integrations/supabase/client'
import { DAY_LABELS, DAY_ORDER, getWeeklyHours, getStoreStatus } from '../../hours'
import MapboxIntegration from './MapboxIntegration'
import { money } from '../../format'
import { compressImageToWebP, isImageFile } from '@/lib/image-compress'
import { buildStoreIcon } from '../../pwa'

const FORM_TABS = ['aparencia', 'loja', 'horarios', 'entrega', 'pedidos']
const TABS = [
  { id: 'aparencia', label: 'Aparência' },
  { id: 'loja', label: 'Loja' },
  { id: 'horarios', label: 'Horários' },
  { id: 'entrega', label: 'Entrega' },
  { id: 'pedidos', label: 'Pedidos' },
  { id: 'integracoes', label: 'Integrações' },
  { id: 'seguranca', label: 'Segurança' },
]

function SettingsPanel() {
  const { config, setConfig, dataReady } = useStore()
  const [formData, setFormData] = useState(config)

  // Só hidrata o formulário depois que o StoreProvider concluir a leitura do Supabase.
  useEffect(() => {
    if (dataReady) setFormData(config)
  }, [dataReady, config])
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState('aparencia')
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [showPasswordChange, setShowPasswordChange] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [passwordSaved, setPasswordSaved] = useState(false)

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!isImageFile(file)) {
      alert('Por favor, selecione um arquivo de imagem (PNG, JPG, WebP...).')
      return
    }
    try {
      const result = await compressImageToWebP(file, { maxWidth: 800, maxHeight: 800, quality: 0.85 })
      setFormData(prev => ({ ...prev, logoUrl: result.dataUrl! }))
    } catch (err: any) {
      alert(err?.message || 'Não foi possível processar a logo.')
    }
  }

  // Banner otimizado automaticamente para WebP antes de salvar nas configurações.
  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!isImageFile(file)) {
      alert('Por favor, selecione um arquivo de imagem (PNG, JPG, WebP...).')
      return
    }
    try {
      const result = await compressImageToWebP(file, { maxWidth: 1600, maxHeight: 1200, quality: 0.82 })
      setFormData(prev => ({ ...prev, bannerImage: result.dataUrl! }))
    } catch (err: any) {
      alert(err?.message || 'Não foi possível processar o banner.')
    }
  }

  const handleNotificationSoundUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.mp3') && file.type !== 'audio/mpeg') {
      alert('Selecione um arquivo de áudio MP3.')
      return
    }
    if (file.size > 1024 * 1024) {
      alert('O MP3 deve ter no máximo 1 MB para ser salvo nas configurações da loja.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setFormData(prev => ({ ...prev, orderNotificationSoundUrl: String(reader.result || '') }))
    reader.onerror = () => alert('Não foi possível ler o arquivo MP3.')
    reader.readAsDataURL(file)
  }

  const testNotificationSound = async () => {
    if (!formData.orderNotificationSoundUrl) {
      alert('Primeiro selecione um arquivo MP3.')
      return
    }
    try {
      window.localStorage.setItem('tratto_order_sound_enabled', '1')
      const audio = new Audio(formData.orderNotificationSoundUrl)
      audio.volume = 1
      await audio.play()
    } catch {
      alert('O navegador bloqueou o áudio. Clique novamente em Testar som e confirme que o volume do computador está ligado.')
    }
  }

  const weekly = getWeeklyHours(formData)
  const previewStatus = getStoreStatus(formData)
  const updateDay = (index: number, patch: Partial<{ open: boolean; openTime: string; closeTime: string }>) => {
    setFormData(prev => ({ ...prev, weeklyHours: getWeeklyHours(prev).map((d, i) => (i === index ? { ...d, ...patch } : d)) }))
  }
  const copyMondayToAll = () => {
    setFormData(prev => {
      const monday = getWeeklyHours(prev)[1]
      return { ...prev, weeklyHours: getWeeklyHours(prev).map(() => ({ ...monday })) }
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dataReady || saving) return
    setSaved(false)
    setSaveFailed(false)
    setSaving(true)
    // Ícone do app instalável da loja: logo centralizada num PNG quadrado (o servidor só entrega o arquivo pronto)
    let pwaIcon = formData.pwaIcon
    try {
      pwaIcon = (await buildStoreIcon(512, { logoUrl: formData.logoUrl, accent: formData.menuButton || '#d9273f', name: formData.name })) || formData.pwaIcon
    } catch { /* o ícone é um extra: nunca impede de salvar */ }
    // Mantém propriedades que já existam na configuração atual e não estejam no formulário.
    const ok = await setConfig({ ...config, ...formData, pwaIcon, weeklyHours: getWeeklyHours(formData) })
    setSaving(false)
    if (ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 4000)
    } else {
      setSaveFailed(true)
      setTimeout(() => setSaveFailed(false), 6000)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordError('')

    if (newPassword.length < 6) {
      setPasswordError('A nova senha deve ter pelo menos 6 caracteres')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('As senhas não coincidem')
      return
    }
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user?.email) {
        setPasswordError('Sessão expirada. Saia e entre novamente.')
        return
      }
      const { error: signError } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword })
      if (signError) {
        setPasswordError('Senha atual incorreta')
        return
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword, current_password: currentPassword })
      if (updateError) {
        setPasswordError('Não foi possível alterar a senha: ' + errorPt(updateError))
        return
      }
    } catch {
      setPasswordError('Não foi possível alterar a senha agora. Tente novamente.')
      return
    }
    setPasswordSaved(true)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setTimeout(() => {
      setPasswordSaved(false)
      setShowPasswordChange(false)
    }, 2000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Configurações</h1>
        <p className="text-gray-500 text-sm">Configure as informações do seu restaurante</p>
      </div>

      {/* Aviso fixo no rodapé da tela: aparece mesmo com a página rolada até o botão Salvar */}
      {(saved || saveFailed) && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white shadow-lg ${saved ? 'bg-green-600' : 'bg-red-600'}`}
        >
          {saved ? <CheckCircle2 size={18} /> : null}
          <span>{saved ? 'Configurações salvas com sucesso!' : 'Não foi possível salvar. Tente novamente.'}</span>
        </div>
      )}

      <div role="tablist" aria-label="Seções das configurações" className="flex gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ${tab === t.id ? 'bg-white text-[#d9273f] shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!dataReady && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Carregando as configurações da loja… O salvamento ficará disponível quando a leitura terminar.</p>}
      <form onSubmit={handleSubmit} className={`space-y-6 ${FORM_TABS.includes(tab) ? '' : 'hidden'}`}>
        <div className={tab === 'aparencia' ? 'space-y-6' : 'hidden'}>
{/* Personalização visual do cardápio */}
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h3 className="text-base font-bold text-gray-800">Identidade visual do cardápio</h3>
            <p className="mt-1 text-sm text-gray-500">Escolha cores que combinem com a logo da sua loja. As alterações aparecem no cardápio público após salvar.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { key: 'menuBackground', label: 'Fundo do cardápio', fallback: '#f3f4f6' },
              { key: 'menuButton', label: 'Botões e ações', fallback: '#d9273f' },
              { key: 'menuPrice', label: 'Preço dos produtos', fallback: '#d9273f' },
              { key: 'menuCategory', label: 'Categorias', fallback: '#d9273f' },
              { key: 'menuTitle', label: 'Título e nome dos produtos', fallback: '#30231e' },
              { key: 'menuDescription', label: 'Descrição dos produtos', fallback: '#776960' },
            ].map((item) => (
              <label key={item.key} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3">
                <span className="text-sm font-medium text-gray-700">{item.label}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-xs uppercase text-gray-400">{formData[item.key] || item.fallback}</span>
                  <input
                    type="color"
                    aria-label={item.label}
                    value={formData[item.key] || item.fallback}
                    onChange={(e) => setFormData(prev => ({ ...prev, [item.key]: e.target.value }))}
                    className="h-9 w-10 cursor-pointer rounded border border-gray-200 bg-white p-1"
                  />
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-100 p-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Prévia</span>
            <span style={{ background: formData.menuButton || '#d9273f' }} className="rounded-full px-3 py-2 text-xs font-bold text-white">+ Adicionar</span>
            <span style={{ color: formData.menuPrice || '#d9273f' }} className="text-sm font-extrabold">R$ 29,90</span>
            <span style={{ color: formData.menuCategory || '#d9273f', borderColor: formData.menuCategory || '#d9273f' }} className="rounded-full border px-3 py-1 text-xs font-semibold">Categoria</span>
            <span style={{ color: formData.menuTitle || '#30231e' }} className="text-sm font-bold">Nome do produto</span>
            <span style={{ color: formData.menuDescription || '#776960' }} className="text-xs">Descrição do produto</span>
          </div>
          <button type="button" onClick={() => setFormData(prev => ({ ...prev, menuBackground: '#f3f4f6', menuButton: '#d9273f', menuPrice: '#d9273f', menuCategory: '#d9273f', menuTitle: '#30231e', menuDescription: '#776960' }))} className="mt-3 text-sm font-semibold text-gray-600 underline underline-offset-2">Restaurar cores padrão</button>
        </section>
        </div>

        <div className={tab === 'loja' ? 'space-y-6' : 'hidden'}>
{/* Store Info */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Store size={18} className="text-[#d9273f]" /> Informações da Loja
          </h3>
          {/* Logo / Banner */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo da Loja</label>
            <p className="text-xs text-gray-400 mb-2">
              O logo aparece no centro do banner, no lugar do nome da loja. Recomendado: PNG com fundo transparente ou com fundo sólido (o banner adota a cor do fundo do logo).
            </p>
            <div className="flex items-center gap-4">
              <div className="w-24 h-24 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 flex items-center justify-center overflow-hidden shrink-0">
                {formData.logoUrl ? (
                  <img src={formData.logoUrl} alt="Logo da loja" className="w-full h-full object-contain" />
                ) : (
                  <span className="text-3xl"></span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="inline-block bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all">
                  {formData.logoUrl ? 'Trocar logo' : 'Upload logo'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
                {formData.logoUrl && (
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, logoUrl: '' }))}
                    className="text-red-500 hover:text-red-600 text-sm font-medium text-left"
                  >
                    Remover logo
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Imagem do Banner (foto de fundo)</label>
            <p className="text-xs text-gray-400 mb-2">
              Foto ou arte que ocupa todo o banner no topo do cardápio. O logo (se houver) fica por cima, no centro. Recomendado: imagem horizontal, ex.: 1600 x 500 px.
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="w-full sm:w-64 h-24 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 flex items-center justify-center overflow-hidden shrink-0">
                {formData.bannerImage ? (
                  <img src={formData.bannerImage} alt="Imagem do banner" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-sm text-gray-400">Nenhuma imagem</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="inline-block bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all text-center">
                  {formData.bannerImage ? 'Trocar imagem do banner' : 'Enviar imagem do banner'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleBannerUpload}
                    className="hidden"
                  />
                </label>
                {formData.bannerImage && (
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, bannerImage: '' }))}
                    className="text-red-500 hover:text-red-600 text-sm font-medium text-left"
                  >
                    Remover imagem do banner
                  </button>
                )}
                <span className="text-xs text-gray-400">Clique em "Salvar Configurações" para publicar.</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nome do Restaurante *</label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Ex: Tratto Hamburgueria"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Subtítulo</label>
              <input
                type="text"
                value={formData.subtitle}
                onChange={e => setFormData(prev => ({ ...prev, subtitle: e.target.value }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Ex: Hamburguer Artesanal"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Telefone</label>
              <input
                type="text"
                value={formData.phone}
                onChange={e => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="(47) 99999-9999"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Endereço</label>
              <input
                type="text"
                value={formData.address}
                onChange={e => setFormData(prev => ({ ...prev, address: e.target.value }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Rua, número, bairro, cidade"
              />
            </div>
          </div>
        </div>

        </div>

        <div className={tab === 'horarios' ? 'space-y-6' : 'hidden'}>
{/* Operating Hours */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-1 flex items-center gap-2">
            <Clock3 size={18} className="text-[#d9273f]" /> Horário de Funcionamento
          </h3>
          <p className="text-xs text-gray-500 mb-4">
            Defina os dias e horários em que a loja atende. Para fechar depois da meia-noite, use um fechamento menor que a abertura (ex.: 18:00 às 02:00).
          </p>
          <div className="space-y-2">
            {DAY_ORDER.map(i => {
              const d = weekly[i]
              return (
                <div key={i} className="flex flex-wrap items-center gap-3 border rounded-lg px-3 py-2">
                  <label className="flex items-center gap-2 w-40 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={d.open}
                      onChange={e => updateDay(i, { open: e.target.checked })}
                      className="w-4 h-4"
                      style={{ accentColor: '#ef4444' }}
                    />
                    <span className="text-sm font-medium text-gray-700">{DAY_LABELS[i]}</span>
                  </label>
                  {d.open ? (
                    <div className="flex items-center gap-2 text-sm">
                      <input
                        type="time"
                        value={d.openTime}
                        onChange={e => updateDay(i, { openTime: e.target.value })}
                        className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <span className="text-gray-500">às</span>
                      <input
                        type="time"
                        value={d.closeTime}
                        onChange={e => updateDay(i, { closeTime: e.target.value })}
                        className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-gray-400">Fechado</span>
                  )}
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={copyMondayToAll}
            className="mt-3 border border-red-500 text-red-500 px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-red-50 transition-all"
          >
            Copiar o horário de segunda para todos os dias
          </button>

          <div className="mt-5 pt-4 border-t space-y-3">
            <label className="flex items-start justify-between gap-4 cursor-pointer">
              <div>
                <p className="text-sm font-medium text-gray-800">Aceitar pedidos agendados</p>
                <p className="text-xs text-gray-500 mt-0.5">Com a loja fechada, o cliente pode encomendar e escolher dia e horário dentro do seu horário de funcionamento. Com a loja aberta, ele pode escolher entre "Agora" e "Agendar".</p>
              </div>
              <span className="relative inline-flex items-center flex-shrink-0">
                <input
                  type="checkbox"
                  checked={formData.schedulingEnabled === true}
                  onChange={e => setFormData(prev => ({ ...prev, schedulingEnabled: e.target.checked }))}
                  className="sr-only peer"
                />
                <span className="w-11 h-6 bg-gray-200 peer-focus:ring-4 peer-focus:ring-red-300 rounded-full peer peer-checked:after:left-[22px] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-500"></span>
              </span>
            </label>
            {formData.schedulingEnabled === true && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block text-xs text-gray-600">Agendar até quantos dias à frente
                  <input type="number" min="1" max="30" className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
                    value={formData.schedulingDays ?? 7}
                    onChange={e => setFormData(prev => ({ ...prev, schedulingDays: Number(e.target.value) || 7 }))} />
                </label>
                <label className="block text-xs text-gray-600">Intervalo entre horários
                  <select className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
                    value={formData.schedulingSlotMinutes ?? 30}
                    onChange={e => setFormData(prev => ({ ...prev, schedulingSlotMinutes: Number(e.target.value) }))}>
                    {[15, 30, 60].map(m => <option key={m} value={m}>{m} minutos</option>)}
                  </select>
                </label>
                <label className="block text-xs text-gray-600">Antecedência mínima (minutos)
                  <input type="number" min="0" step="5" className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
                    value={formData.schedulingLeadMinutes ?? 60}
                    onChange={e => setFormData(prev => ({ ...prev, schedulingLeadMinutes: Math.max(0, Number(e.target.value) || 0) }))} />
                </label>
              </div>
            )}
          </div>

          <div className="mt-5 pt-4 border-t space-y-3">
            <div>
              <p className="text-sm font-medium text-gray-800">Pix da loja</p>
              <p className="text-xs text-gray-500 mt-0.5">Quando o cliente escolher pagar com Pix, ele vê o QR Code e o "copia e cola" com o valor do pedido ao finalizar. Deixe a chave em branco para enviar a chave pelo WhatsApp.</p>
            </div>
            <label className="block text-xs text-gray-600">Chave Pix (CPF/CNPJ, e-mail, celular ou aleatória)
              <input className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={formData.pixKey ?? ''}
                onChange={e => setFormData(prev => ({ ...prev, pixKey: e.target.value }))} />
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-gray-600">Nome do recebedor (como no banco)
                <input maxLength={25} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={formData.pixHolder ?? ''}
                  placeholder={formData.name || ''}
                  onChange={e => setFormData(prev => ({ ...prev, pixHolder: e.target.value }))} />
              </label>
              <label className="block text-xs text-gray-600">Cidade
                <input maxLength={15} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={formData.pixCity ?? ''}
                  onChange={e => setFormData(prev => ({ ...prev, pixCity: e.target.value }))} />
              </label>
            </div>
          </div>

          <div className="mt-5 pt-4 border-t">
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={formData.isOpen}
                onChange={e => setFormData(prev => ({ ...prev, isOpen: e.target.checked }))}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-red-300 rounded-full peer peer-checked:after:left-[22px] peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-500"></div>
              <span className="ml-3 text-sm font-medium text-gray-700">
                {formData.isOpen ? ' Loja funcionando no horário acima' : ' Loja fechada agora (ignora o horário)'}
              </span>
            </label>
            <p className="text-xs text-gray-500 mt-1">Desligue para fechar a loja na hora, mesmo dentro do horário (feriado, imprevisto).</p>
          </div>
        </div>

        </div>

        <div className={tab === 'entrega' ? 'space-y-6' : 'hidden'}>
{/* Delivery Settings */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Truck size={18} className="text-[#d9273f]" /> Configurações de Entrega
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Taxa base de entrega (R$)</label>
              <input
                type="number"
                step="0.01"
                value={formData.deliveryFee}
                onChange={e => setFormData(prev => ({ ...prev, deliveryFee: parseFloat(e.target.value) || 0 }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Valor por km rodado (R$)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={formData.deliveryPerKm ?? 0}
                onChange={e => setFormData(prev => ({ ...prev, deliveryPerKm: parseFloat(e.target.value) || 0 }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <p className="text-xs text-gray-500 mt-1">Use 0 para não cobrar por km (só a taxa base). O cálculo pelo Mapbox é ligado ou desligado na aba Entrega.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Distância máxima de entrega (km)</label>
              <input
                type="number"
                step="0.1"
                min="0"
                value={formData.maxDeliveryKm ?? 0}
                onChange={e => setFormData(prev => ({ ...prev, maxDeliveryKm: parseFloat(e.target.value) || 0 }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <p className="text-xs text-gray-500 mt-1">Use 0 para não limitar. Acima disso o pedido para entrega é bloqueado.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pedido mínimo (R$)</label>
              <input
                type="number"
                step="0.01"
                value={formData.minOrder}
                onChange={e => setFormData(prev => ({ ...prev, minOrder: parseFloat(e.target.value) || 0 }))}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-4">
            Frete = taxa base + valor por km × distância pela rota de carro (calculada pelo Mapbox a partir do endereço da loja). Requer o token do Mapbox em Integrações.
          </p>
        </div>

        </div>

        <div className={tab === 'pedidos' ? 'space-y-6' : 'hidden'}>
{/* Som de novo pedido */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-2 flex items-center gap-2">
            <Volume2 size={18} className="text-[#d9273f]" /> Notificação sonora de pedidos
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            Envie um MP3 para tocar automaticamente quando um novo pedido chegar ao painel desta loja. O arquivo fica salvo nas configurações.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label className="inline-flex w-fit items-center gap-2 cursor-pointer rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
              <Music size={16} />
              {formData.orderNotificationSoundUrl ? 'Trocar arquivo MP3' : 'Selecionar arquivo MP3'}
              <input type="file" accept=".mp3,audio/mpeg" onChange={handleNotificationSoundUpload} className="hidden" />
            </label>
            {formData.orderNotificationSoundUrl && (
              <button type="button" onClick={() => setFormData(prev => ({ ...prev, orderNotificationSoundUrl: '' }))} className="text-sm text-red-600 hover:text-red-700 text-left">
                Remover áudio
              </button>
            )}
            <button type="button" onClick={testNotificationSound} disabled={!formData.orderNotificationSoundUrl} className="inline-flex w-fit items-center gap-2 rounded-lg bg-[#d9273f] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#c01f35] disabled:opacity-40">
              <Play size={16} /> Testar e ativar som
            </button>
          </div>
          {formData.orderNotificationSoundUrl && (
            <p className="mt-3 text-xs text-green-700">MP3 selecionado. Clique em “Salvar Configurações” para gravar a alteração.</p>
          )}
          <p className="mt-2 text-xs text-gray-500">
            Limite: 1 MB. O navegador pode exigir que você clique em “Testar e ativar som” uma vez para autorizar a reprodução automática.
          </p>
        </div>

        {/* Impressão automática de pedidos */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-2 flex items-center gap-2">
            <Printer size={18} className="text-[#d9273f]" /> Impressão automática de pedidos
          </h3>
          <p className="text-sm text-gray-500 mb-4">
            Quando ativada, o sistema abre a impressão do comprovante assim que um novo pedido chegar, mesmo que você esteja em outra aba do painel.
          </p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(formData.autoPrintNewOrders)}
              onChange={e => setFormData(prev => ({ ...prev, autoPrintNewOrders: e.target.checked }))}
              className="mt-1 h-4 w-4 accent-[#d9273f]"
            />
            <span>
              <span className="block text-sm font-semibold text-gray-800">Imprimir automaticamente novos pedidos</span>
              <span className="block text-xs text-gray-500 mt-1">Desative para imprimir apenas manualmente pelo botão “Imprimir”.</span>
            </span>
          </label>
          <p className="mt-3 text-xs text-amber-700">
            Observação: o navegador pode exigir confirmação na janela de impressão. Para impressão sem diálogo, normalmente é necessário configurar o computador/ navegador em modo quiosque com uma impressora padrão.
          </p>
        </div>

        </div>

        <div className={tab === 'loja' ? 'space-y-6' : 'hidden'}>
{/* Preview */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Eye size={18} className="text-[#d9273f]" /> Pré-visualização
          </h3>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-3">
              {formData.logoUrl ? (
                <img
                  src={formData.logoUrl}
                  alt={`${formData.name} logo`}
                  className="w-12 h-12 rounded-xl object-contain bg-gray-100"
                />
              ) : (
                <div className="w-12 h-12 bg-red-500 rounded-xl flex items-center justify-center">
                  <span className="text-white font-bold text-lg">{formData.name.charAt(0)}</span>
                </div>
              )}
              <div>
                <h4 className="font-bold text-gray-800">{formData.name}</h4>
                <p className="text-xs text-gray-500">{formData.subtitle}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
              <span><MapPin size={14} /> {formData.address}</span>
              <span> {formData.phone}</span>
              <span className={previewStatus.open ? 'text-green-600' : 'text-red-600'}>
                ● {previewStatus.text}
              </span>
            </div>
            <div className="mt-2 flex gap-4 text-xs">
              <span className="text-green-700 font-medium"> Entrega: {money(formData.deliveryFee)}</span>
              <span className="text-gray-500">Pedido mín: {money(formData.minOrder)}</span>
            </div>
          </div>
        </div>

        </div>

        <button
          type="submit"
          disabled={saving || !dataReady}
          className={`w-full text-white py-3 rounded-xl font-bold text-sm transition-all disabled:opacity-70 ${saved ? 'bg-green-600 hover:bg-green-600' : 'bg-red-500 hover:bg-red-600'}`}
        >
          {saving ? 'Salvando…' : saved ? '✓ Salvo!' : 'Salvar Configurações'}
        </button>
      </form>

      {/* Integrações */}
      {tab === 'integracoes' && <MapboxIntegration />}

      {/* Security Section */}
      {tab === 'seguranca' && <div className="bg-white rounded-xl shadow-sm p-6">
        <h3 className="font-bold text-gray-800 mb-4 flex items-center gap-2">
          <ShieldCheck size={18} className="text-[#d9273f]" /> Segurança - Senha de Acesso
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          Altere a senha usada para acessar o painel administrativo.
        </p>
        
        {!showPasswordChange ? (
          <button
            type="button"
            onClick={() => setShowPasswordChange(true)}
            className="border border-red-500 text-red-500 px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-50 transition-all"
          >
            Alterar Senha
          </button>
        ) : (
          <form onSubmit={handleChangePassword} className="space-y-4">
            {passwordSaved && (
              <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-3 flex items-center gap-2">
                <CheckCircle2 size={18} />
                <span className="text-sm font-medium">Senha alterada com sucesso!</span>
              </div>
            )}
            {passwordError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 flex items-center gap-2">
                <AlertTriangle size={18} />
                <span className="text-sm font-medium">{passwordError}</span>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Senha Atual</label>
              <PasswordInput
                required
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Digite a senha atual"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nova Senha</label>
              <PasswordInput
                required
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Mínimo 6 caracteres"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar Nova Senha</label>
              <PasswordInput
                required
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="Repita a nova senha"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setShowPasswordChange(false); setPasswordError('') }}
                className="flex-1 border border-gray-300 text-gray-700 py-2.5 rounded-lg font-medium text-sm hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="flex-1 bg-red-500 hover:bg-red-600 text-white py-2.5 rounded-lg font-medium text-sm"
              >
                Confirmar Alteração
              </button>
            </div>
          </form>
        )}
      </div>}
    </div>
  )
}

export default SettingsPanel
