// @ts-nocheck -- código original migrado sem alterações de lógica
import { formatOrderNumber } from '../orderNumber'
import { trackAddToCart, trackInitiateCheckout, trackViewContent, trackPurchase } from '../marketing'
import { useState, useRef, useEffect } from 'react'
import { validateCoupon } from '../coupons'
import { useStore } from '../context/StoreContext'
import { Product, CartItem, ProductAddOn, Order, DeliveryType, PaymentMethod } from '../types'
import { getMapboxToken } from '../mapboxToken'
import { fetchAddressByCep } from '../cep'
import { pixPayload } from '../pix'
import PixQrCode from './PixQrCode'
import { buildWhatsAppUrl } from '../whatsapp'
import { getStoreStatus, getScheduleSlots, formatScheduled } from '../hours'
import { extractLogoBackground } from '../logoColor'
import { geocodeAddress, drivingDistanceKm, roundMoney } from '../freight'
import { money, money as fmt } from '../format'


// preço unitário do item do carrinho (produto + adicionais selecionados)
const getItemUnitPrice = (item: CartItem) =>
  item.product.price + (item.selectedAddOns || []).reduce((sum, a) => sum + a.price, 0)

// ---- Cor de destaque da loja (botões, seleção, bordas) ----
// Vem do painel (Configurações > cores do cardápio). Os vermelhos de status/erro continuam fixos.
const DEFAULT_ACCENT = '#d9273f'
function tint(hex: string | undefined, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || '').trim())
  if (!m) return `rgba(217, 39, 63, ${alpha})`
  let h = m[1]
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function MenuView() {
  const { config, products, categories, deliveryZones, addOrder } = useStore()
  const accent = config.menuButton || DEFAULT_ACCENT
  const accentSoft = tint(accent, 0.1) // fundo de opção selecionada
  const accentShadow = tint(accent, 0.3) // sombra dos botões principais
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id || '')
  const [cart, setCart] = useState<CartItem[]>([])
  const [showCart, setShowCart] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [showProductModal, setShowProductModal] = useState(false)
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([])
  // quando editando uma linha do carrinho, o modal salva as alterações na própria linha
  const [editingCartKey, setEditingCartKey] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  // Checkout (aparece após "Finalizar pedido" no carrinho)
  const [showCheckout, setShowCheckout] = useState(false)
  const [checkoutStep, setCheckoutStep] = useState(1)
  const [deliveryType, setDeliveryType] = useState<DeliveryType>('pickup')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('')
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [addrStreet, setAddrStreet] = useState('')
  const [addrNeighborhood, setAddrNeighborhood] = useState('')
  const [addrCity, setAddrCity] = useState('')
  const [customerNumber, setCustomerNumber] = useState('')
  const [cep, setCep] = useState('')
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [cepMessage, setCepMessage] = useState('')
  const cepRequestRef = useRef(0)
  // true quando a rua veio do CEP: o endereço fica preenchido e travado, só falta o número
  const [locked, setLocked] = useState({ street: false, neighborhood: false, city: false })
  const customerAddress = [addrStreet.trim(), addrNeighborhood.trim(), addrCity.trim()].filter(Boolean).join(', ')

  // ---- Frete por distância (taxa base + valor por km, distância pela rota do Mapbox) ----
  const perKm = Number(config.deliveryPerKm) || 0
  const maxKm = Number(config.maxDeliveryKm) || 0
  // Chaves do painel (Entrega): taxas fixas por bairro e/ou cálculo automático pelo Mapbox
  const mapboxEnabled = config.mapboxFreightEnabled !== false
  const pickupEnabled = config.pickupEnabled !== false
  const fixedEnabled = config.fixedZoneFeesEnabled === true
  const normText = (t: string) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
  const matchedZone = deliveryType === 'delivery' && fixedEnabled && addrNeighborhood.trim()
    ? deliveryZones.find(z => normText(z.name) === normText(addrNeighborhood)) || null
    : null
  const fixedOnlyNoMatch = deliveryType === 'delivery' && fixedEnabled && !mapboxEnabled && !matchedZone
  const useDistanceFreight = deliveryType === 'delivery' && mapboxEnabled && !matchedZone
  const [freight, setFreight] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error' | 'out'; km: number; fee: number }>({
    status: 'idle', km: 0, fee: 0
  })
  const freightRequestRef = useRef(0)

  // Status da loja (aberto/fechado) pelo horário do dia; atualiza a cada minuto
  const [, setClockTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setClockTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])
  const storeStatus = getStoreStatus(config)
  // ---- Agendamento ----
  const schedulingEnabled = config.schedulingEnabled === true
  const constrainedProducts = cart
    .map(item => item.product)
    .filter(product => Array.isArray(product.deliveryDays) && product.deliveryDays.length > 0)
  const weekdayNames = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
  const formatProductDeliveryDays = (product: Product) =>
    (product.deliveryDays || []).map(day => weekdayNames[day]).filter(Boolean).join(', ')
  const productScheduleRequired = constrainedProducts.length > 0
  const mustSchedule = (schedulingEnabled && !storeStatus.open) || productScheduleRequired
  const [whenMode, setWhenMode] = useState<'now' | 'schedule'>('now')
  const [schedDate, setSchedDate] = useState('')
  const [schedTime, setSchedTime] = useState('')
  const scheduling = mustSchedule || (schedulingEnabled && whenMode === 'schedule')
  // Mostra todas as datas disponíveis para explicar quais produtos não aceitam a data escolhida.
  const scheduleDays = (schedulingEnabled || productScheduleRequired) && showCheckout
    ? getScheduleSlots(config)
    : []
  const selectedDay = scheduleDays.find(d => d.date === schedDate)
  const selectedWeekday = selectedDay ? new Date(selectedDay.date + 'T12:00:00Z').getUTCDay() : null
  const incompatibleProducts = selectedWeekday === null
    ? []
    : constrainedProducts.filter(product => !product.deliveryDays!.includes(selectedWeekday))
  const scheduleOk = !scheduling || !!(selectedDay && selectedDay.times.includes(schedTime) && incompatibleProducts.length === 0)

  // Cor do banner = cor de fundo do logo enviado (o logo se funde ao banner)
  const [logoBg, setLogoBg] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (!config.logoUrl) { setLogoBg(null); return }
    extractLogoBackground(config.logoUrl).then(color => { if (active) setLogoBg(color) })
    return () => { active = false }
  }, [config.logoUrl])

  useEffect(() => {
    const requestId = ++freightRequestRef.current
    if (!useDistanceFreight || !addrStreet.trim() || !customerNumber.trim()) {
      setFreight({ status: 'idle', km: 0, fee: 0 })
      return
    }
    setFreight({ status: 'loading', km: 0, fee: 0 })
    const timer = setTimeout(async () => {
      const stale = () => requestId !== freightRequestRef.current
      const fail = () => { if (!stale()) setFreight({ status: 'error', km: 0, fee: 0 }) }
      try {
        const token = getMapboxToken()
        if (!token) return fail()
        const origin = await geocodeAddress(config.address, token, 'address,street,neighborhood,locality,place')
        if (stale()) return
        if (!origin) return fail()
        const num = (customerNumber.match(/\d+/) || [''])[0]
        const query = [
          `${addrStreet.trim()}${num ? ' ' + num : ''}`,
          addrNeighborhood.trim(),
          addrCity.trim()
        ].filter(Boolean).join(', ')
        const dest = await geocodeAddress(query, token, 'address,street', origin)
        if (stale()) return
        if (!dest) return fail()
        const km = await drivingDistanceKm(origin, dest, token)
        if (stale()) return
        if (km === null) return fail()
        if (maxKm > 0 && km > maxKm) {
          setFreight({ status: 'out', km, fee: 0 })
          return
        }
        setFreight({ status: 'ok', km, fee: roundMoney(config.deliveryFee + perKm * km) })
      } catch {
        fail()
      }
    }, 800)
    return () => clearTimeout(timer)
  }, [useDistanceFreight, addrStreet, addrNeighborhood, addrCity, customerNumber, config.address, config.deliveryFee, perKm, maxKm])
  const numberInputRef = useRef<HTMLInputElement | null>(null)
  const [changeFor, setChangeFor] = useState('')
  const [orderPlaced, setOrderPlaced] = useState<Order | null>(null)
  const whatsappUrl = orderPlaced ? buildWhatsAppUrl(orderPlaced, config) : ''

  // Abre o WhatsApp da loja com o pedido pronto e volta ao cardápio
  const sendOrderToWhatsApp = () => {
    if (!whatsappUrl) return
    const win = window.open(whatsappUrl, '_blank', 'noopener,noreferrer')
    if (!win) window.location.href = whatsappUrl
    setOrderPlaced(null)
  }
  const sectionRefs = useRef<{ [key: string]: HTMLElement | null }>({})

  // Detect mobile
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640)
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const addToCart = (product: Product, addOnIds: string[] = [], incQty = false) => {
    trackAddToCart(product, 1)
    const chosenAddOns = (product.addOns || []).filter(a => addOnIds.includes(a.id))
    setCart(prev => {
      const keyOf = (item: CartItem) =>
        item.product.id + '|' + [...(item.selectedAddOns || [])].map(a => a.id).sort().join(',')
      const key = product.id + '|' + chosenAddOns.map(a => a.id).sort().join(',')
      const existing = prev.find(item => keyOf(item) === key)
      if (existing) {
        return prev.map(item => keyOf(item) === key ? { ...item, quantity: item.quantity + (incQty ? 1 : 0) } : item)
      }
      return [...prev, { product, quantity: 1, selectedAddOns: chosenAddOns }]
    })
  }

  const removeFromCart = (productId: string, addOnIds?: string[]) => {
    setCart(prev => {
      const targetKey = addOnIds
        ? productId + '|' + [...addOnIds].sort().join(',')
        : undefined
      // se passou os adicionais, mexe exatamente naquele item; senão remove o último desse produto
      for (let i = prev.length - 1; i >= 0; i--) {
        const k = prev[i].product.id + '|' + [...(prev[i].selectedAddOns || [])].map(a => a.id).sort().join(',')
        if (targetKey ? k === targetKey : prev[i].product.id === productId) {
          if (prev[i].quantity > 1) {
            return prev.map((item, idx) => idx === i ? { ...item, quantity: item.quantity - 1 } : item)
          }
          return prev.filter((_, idx) => idx !== i)
        }
      }
      return prev
    })
  }

  const getCartQuantity = (productId: string) => {
    const item = cart.find(item => item.product.id === productId)
    return item ? item.quantity : 0
  }

  const itemKeyOf = (item: CartItem) =>
    item.product.id + '|' + [...(item.selectedAddOns || [])].map(a => a.id).sort().join(',')

  // abre o modal do produto para editar os extras de uma linha específica do carrinho
  const openEditExtras = (item: CartItem) => {
    setSelectedProduct(item.product)
    setSelectedAddOns((item.selectedAddOns || []).map(a => a.id))
    setEditingCartKey(itemKeyOf(item))
    setShowProductModal(true)
  }

  // salva as seleções do modal na própria linha do carrinho (preço e quantidade atualizados)
  const updateCartItemAddOns = () => {
    if (!selectedProduct || !editingCartKey) return
    const chosenAddOns = (selectedProduct.addOns || []).filter(a => selectedAddOns.includes(a.id))
    const newKey = selectedProduct.id + '|' + chosenAddOns.map(a => a.id).sort().join(',')
    setCart(prev => {
      const idx = prev.findIndex(i => itemKeyOf(i) === editingCartKey)
      if (idx === -1) return prev.filter(i => itemKeyOf(i) !== newKey)
      const edited = { ...prev[idx], selectedAddOns: chosenAddOns }
      // se já existir outra linha idêntica à nova, soma as quantidades e remove a editada
      const dupIdx = prev.findIndex((i, j) => j !== idx && itemKeyOf(i) === newKey)
      if (dupIdx !== -1) {
        const merged = { ...prev[dupIdx], quantity: prev[dupIdx].quantity + prev[idx].quantity }
        return prev.map((i, j) => (j === dupIdx ? merged : i)).filter((_, j) => j !== idx)
      }
      return prev.map((i, j) => (j === idx ? edited : i))
    })
    setEditingCartKey(null)
    setShowProductModal(false)
  }

  // marca/desmarca um adicional direto na linha do carrinho (sem abrir a página/modal do produto)
  const toggleCartItemAddOn = (item: CartItem, addOnId: string) => {
    const currentIds = (item.selectedAddOns || []).map(a => a.id)
    const nextIds = currentIds.includes(addOnId)
      ? currentIds.filter(id => id !== addOnId)
      : [...currentIds, addOnId]
    const chosenAddOns = (item.product.addOns || []).filter(a => nextIds.includes(a.id))
    const oldKey = itemKeyOf(item)
    const newKey = item.product.id + '|' + chosenAddOns.map(a => a.id).sort().join(',')
    setCart(prev => {
      const idx = prev.findIndex(i => itemKeyOf(i) === oldKey)
      if (idx === -1) return prev
      // se já existir outra linha idêntica à nova, soma as quantidades e remove a editada
      const dupIdx = prev.findIndex((i, j) => j !== idx && itemKeyOf(i) === newKey)
      if (dupIdx !== -1) {
        const merged = { ...prev[dupIdx], quantity: prev[dupIdx].quantity + prev[idx].quantity }
        return prev.map((i, j) => (j === dupIdx ? merged : i)).filter((_, j) => j !== idx)
      }
      return prev.map((i, j) => (j === idx ? { ...i, selectedAddOns: chosenAddOns } : i))
    })
  }

  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0)
  const totalPrice = cart.reduce((sum, item) => sum + getItemUnitPrice(item) * item.quantity, 0)

  // ---- Checkout helpers ----
  const checkoutDeliveryFee =
    deliveryType === 'delivery'
      ? (matchedZone ? matchedZone.price : (useDistanceFreight && freight.status === 'ok' ? freight.fee : config.deliveryFee))
      : 0
  const deliveryFeeLabel = matchedZone ? fmt(matchedZone.price)
    : fixedOnlyNoMatch ? (addrNeighborhood.trim() ? 'Fora da área' : 'Informe o bairro')
    : !useDistanceFreight
    ? fmt(config.deliveryFee)
    : freight.status === 'ok' ? fmt(freight.fee)
    : freight.status === 'loading' ? 'Calculando...'
    : freight.status === 'out' ? 'Fora da área'
    : freight.status === 'error' ? fmt(config.deliveryFee)
    : 'Informe o endereço'
  const [couponInput, setCouponInput] = useState('')
  const [appliedCode, setAppliedCode] = useState('')
  const [couponMsg, setCouponMsg] = useState('')
  // revalida sempre que o carrinho muda (pedido mínimo, etc.)
  const couponCheck = appliedCode ? validateCoupon(config.coupons, appliedCode, totalPrice) : null
  const discount = couponCheck && couponCheck.ok ? couponCheck.discount : 0
  const activeCouponCode = couponCheck && couponCheck.ok ? couponCheck.coupon.code : ''
  const applyCoupon = () => {
    const r = validateCoupon(config.coupons, couponInput, totalPrice)
    if (r.ok) { setAppliedCode(r.coupon.code); setCouponMsg('') }
    else { setAppliedCode(''); setCouponMsg(r.message) }
  }
  const removeCoupon = () => { setAppliedCode(''); setCouponInput(''); setCouponMsg('') }
  const checkoutTotal = Math.max(0, totalPrice - discount) + checkoutDeliveryFee
  const changeValue = parseFloat((changeFor || '').replace(',', '.')) || 0
  const paymentLabels: Record<PaymentMethod, string> = {
    card: 'Cartão',
    pix: 'PIX',
    cash: 'Dinheiro',
  }
  const applyAddress = (street: string, neighborhood: string, city: string) => {
    setAddrStreet(street)
    setAddrNeighborhood(neighborhood)
    setAddrCity(city)
    setLocked({ street: !!street, neighborhood: !!neighborhood, city: !!city })
  }

  // Busca o endereço pelo CEP (ViaCEP; Mapbox como reserva) e aplica no formulário
  const lookupCep = async (digits: string) => {
    const requestId = ++cepRequestRef.current
    const stale = () => requestId !== cepRequestRef.current
    setCepStatus('loading')
    setCepMessage('Buscando endereço...')
    applyAddress('', '', '')

    const found = await fetchAddressByCep(digits, getMapboxToken(), stale)
    if (stale()) return
    if (!found) {
      setCepStatus('error')
      setCepMessage('Não encontramos esse CEP. Preencha o endereço manualmente.')
      return
    }
    applyAddress(found.street, found.neighborhood, found.city)
    setCepStatus('ok')
    if (found.source === 'mapbox') {
      setCepMessage('CEP localizado só em parte. Complete a rua e informe o número.')
    } else if (found.street) {
      setCepMessage('Endereço encontrado! Informe o número e o complemento.')
      setTimeout(() => numberInputRef.current?.focus(), 50)
    } else {
      setCepMessage('CEP localizado. Informe a rua e o número.')
    }
  }

  const handleCepChange = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 8)
    setCep(digits.length > 5 ? digits.slice(0, 5) + '-' + digits.slice(5) : digits)
    if (digits.length === 8) {
      lookupCep(digits)
    } else {
      cepRequestRef.current++
      setCepStatus('idle')
      setCepMessage('')
      setLocked({ street: false, neighborhood: false, city: false })
    }
  }

  // Se a loja desligou a retirada, o pedido é sempre entrega
  useEffect(() => { if (!pickupEnabled && deliveryType === 'pickup') setDeliveryType('delivery') }, [pickupEnabled, deliveryType])

  const canPlaceOrder =
    scheduleOk &&
    customerName.trim() !== '' &&
    customerPhone.trim() !== '' &&
    paymentMethod !== '' &&
    (deliveryType === 'pickup' || (addrStreet.trim() !== '' && customerNumber.trim() !== '')) &&
    !(useDistanceFreight && (freight.status === 'idle' || freight.status === 'loading' || freight.status === 'out')) &&
    !fixedOnlyNoMatch

  const canContinueCheckoutStep1 = scheduleOk && customerName.trim() !== '' && customerPhone.trim() !== '' && (deliveryType === 'pickup' || (addrStreet.trim() !== '' && customerNumber.trim() !== '' && (!fixedEnabled || !!addrNeighborhood.trim()))) && !(useDistanceFreight && (freight.status === 'idle' || freight.status === 'loading' || freight.status === 'out')) && !fixedOnlyNoMatch
  const openCheckout = () => {
    trackInitiateCheckout(cart, totalPrice)
    setCheckoutStep(1)
    setShowCart(false)
    setShowCheckout(true)
  }

  const placingRef = useRef(false)
  const [placingOrder, setPlacingOrder] = useState(false)
  const placeOrder = async () => {
    if (!canPlaceOrder || placingRef.current) return
    placingRef.current = true
    setPlacingOrder(true)
    const now = new Date().toISOString()
    const order: Order = {
      id: '#' + Date.now().toString(36).slice(-6).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0'),
      items: cart,
      total: totalPrice,
      deliveryFee: checkoutDeliveryFee,
      discount: discount > 0 ? discount : undefined,
      couponCode: discount > 0 ? activeCouponCode : undefined,
      status: 'pending',
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerAddress: deliveryType === 'delivery'
        ? `${customerAddress.trim()}, nº ${customerNumber.trim()}${cep.length === 9 ? ' - CEP ' + cep : ''}`
        : '',
      deliveryType,
      scheduledDate: scheduling ? schedDate : undefined,
      scheduledTime: scheduling ? schedTime : undefined,
      paymentMethod: paymentMethod as PaymentMethod,
      changeFor: paymentMethod === 'cash' && changeValue > checkoutTotal ? changeValue : undefined,
      createdAt: now,
      updatedAt: now,
    }
    try {
      const saved = await addOrder(order)
      if (!saved) return
    } catch (error) {
      console.error('Falha ao registrar pedido:', error)
      alert('Não foi possível registrar o pedido. Nenhuma cobrança foi confirmada. Tente novamente ou fale com a loja.')
      return
    } finally {
      placingRef.current = false
      setPlacingOrder(false)
    }
    void trackPurchase(order, Math.round((order.total + order.deliveryFee - (order.discount || 0)) * 100) / 100)
    setOrderPlaced(order)
    setShowCheckout(false)
    setCart([])
    setWhenMode('now'); setSchedDate(''); setSchedTime('')
    removeCoupon()
    setPaymentMethod('')
    setChangeFor('')
    setAddrStreet('')
    setAddrNeighborhood('')
    setAddrCity('')
    setCustomerNumber('')
    setCep('')
    setCepStatus('idle')
    setCepMessage('')
    setLocked({ street: false, neighborhood: false, city: false })
  }

  const scrollToCategory = (categoryId: string) => {
    setActiveCategory(categoryId)
    sectionRefs.current[categoryId]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const openProductModal = (product: Product) => {
    trackViewContent(product)
    setSelectedProduct(product)
    setSelectedAddOns([])
    setShowProductModal(true)
  }

  const toggleAddOn = (addOnId: string) => {
    setSelectedAddOns(prev =>
      prev.includes(addOnId) ? prev.filter(id => id !== addOnId) : [...prev, addOnId]
    )
  }

  const selectedAddOnsTotal = selectedProduct
    ? (selectedProduct.addOns || [])
        .filter(a => selectedAddOns.includes(a.id))
        .reduce((sum, a) => sum + a.price, 0)
    : 0
  const modalItemTotal = (selectedProduct?.price || 0) + selectedAddOnsTotal

  const availableProducts = products.filter(p => p.available)
  const sortedCategories = [...categories].sort((a, b) => a.order - b.order)

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: config.menuBackground || '#f3f4f6',
      '--menu-button': config.menuButton || '#d9273f',
      '--menu-price': config.menuPrice || '#d9273f',
      '--menu-category': config.menuCategory || '#d9273f',
      '--menu-title': config.menuTitle || '#30231e',
      '--menu-description': config.menuDescription || '#776960',
    } as React.CSSProperties}>
      {/* Hero Banner - Mobile Optimized */}
      <div style={{
        position: 'relative',
        height: isMobile ? '160px' : '240px',
        background: config.bannerImage
          ? `#111827 url("${config.bannerImage}") center / cover no-repeat`
          : (config.logoUrl && logoBg ? logoBg : 'linear-gradient(135deg, #1f2937 0%, #111827 50%, #1f2937 100%)'),
        transition: 'background 0.3s ease',
        overflow: 'hidden'
      }}>
        {(config.bannerImage || !(config.logoUrl && logoBg)) && (
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.4)' }}></div>
        )}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '0 16px' }}>
            {config.logoUrl ? (
              <img
                src={config.logoUrl}
                alt={config.name}
                style={{
                  maxHeight: isMobile ? '110px' : '180px',
                  maxWidth: '80%',
                  objectFit: 'contain',
                  margin: '0 auto',
                  display: 'block',
                  borderRadius: config.bannerImage ? '12px' : 0
                }}
              />
            ) : (
              <>
                <h1 style={{
                  fontSize: isMobile ? '28px' : '48px',
                  fontWeight: 'bold',
                  color: 'white',
                  letterSpacing: '0.05em',
                  margin: 0,
                  lineHeight: 1.1
                }}>
                  {config.name.toUpperCase()}
                </h1>
                <p style={{
                  color: '#fb923c',
                  fontSize: isMobile ? '11px' : '14px',
                  marginTop: '6px',
                  letterSpacing: '0.15em',
                  fontWeight: 500
                }}>
                  {config.subtitle.toUpperCase()}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Restaurant Info Card */}
      <div style={{ 
        maxWidth: '896px', 
        margin: '0 auto', 
        padding: '0 12px',
        marginTop: '-32px',
        position: 'relative',
        zIndex: 10
      }}>
        <div style={{
          backgroundColor: 'white',
          borderRadius: '16px',
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
          padding: isMobile ? '12px 14px' : '20px'
        }}>
          {isMobile ? (
            <>
              {/* Versão compacta para celular */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 'bold', color: config.menuTitle || '#1f2937', margin: 0, lineHeight: 1.25 }}>
                    {config.name}
                  </h2>
                  {config.subtitle && (
                    <p style={{ fontSize: '12px', color: config.menuDescription || '#6b7280', margin: '1px 0 0 0' }}>{config.subtitle}</p>
                  )}
                </div>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px', flexShrink: 0,
                  padding: '4px 9px', borderRadius: '20px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
                  backgroundColor: storeStatus.open ? '#dcfce7' : '#fee2e2',
                  color: storeStatus.open ? '#166534' : '#b91c1c'
                }}>
                  <span style={{
                    width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
                    backgroundColor: storeStatus.open ? '#22c55e' : '#ef4444'
                  }}></span>
                  {storeStatus.open ? 'Aberto' : 'Fechado'}
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px', alignItems: 'center' }}>
                {storeStatus.text.includes('•') && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '14px',
                    fontSize: '11px', fontWeight: 600,
                    backgroundColor: storeStatus.open ? '#dcfce7' : '#fee2e2',
                    color: storeStatus.open ? '#166534' : '#b91c1c'
                  }}>
                    🕐 {storeStatus.text.split('•').slice(1).join('•').trim()}
                  </span>
                )}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: '#f3f4f6', color: '#374151', padding: '3px 8px', borderRadius: '14px', fontSize: '11px', fontWeight: 600 }}>
                  ★ 4.8
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: '#f3f4f6', color: '#374151', padding: '3px 8px', borderRadius: '14px', fontSize: '11px', fontWeight: 500 }}>
                  40–50 min
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: '#f3f4f6', color: '#374151', padding: '3px 8px', borderRadius: '14px', fontSize: '11px', fontWeight: 500 }}>
                  2.5 km
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', backgroundColor: '#f0fdf4', color: '#15803d', padding: '3px 8px', borderRadius: '14px', fontSize: '11px', fontWeight: 600 }}>
                  {'🏷️'} {fixedEnabled && !mapboxEnabled ? 'Taxa por bairro' : `Entrega ${mapboxEnabled && perKm > 0 ? 'desde ' : ''}${fmt(config.deliveryFee)}`}
                </span>
              </div>
            </>
          ) : (
            <>
          <h2 style={{ 
            fontSize: isMobile ? '16px' : '22px', 
            fontWeight: 'bold', 
            color: config.menuTitle || '#1f2937',
            margin: 0,
            lineHeight: 1.3
          }}>
            {config.name}
          </h2>
          <p style={{ fontSize: '13px', color: config.menuDescription || '#6b7280', margin: '2px 0 0 0' }}>
            {config.subtitle}
          </p>

          {/* Info Pills - Responsive */}
          <div style={{ 
            display: 'flex', 
            flexWrap: 'wrap', 
            gap: '8px', 
            marginTop: '12px',
            alignItems: 'center'
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#dcfce7',
              color: '#166534',
              padding: '4px 10px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 600
            }}>
              ★ 4.8 <span style={{ color: config.menuDescription || '#6b7280', fontWeight: 400 }}>(2.4k+)</span>
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              padding: '4px 10px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 500
            }}>
              40–50 min
            </span>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              backgroundColor: '#f3f4f6',
              color: '#374151',
              padding: '4px 10px',
              borderRadius: '20px',
              fontSize: '12px',
              fontWeight: 500
            }}>
              2.5 km
            </span>
          </div>

          {/* Delivery Info */}
          <div style={{ 
            display: 'flex', 
            flexWrap: 'wrap',
            gap: isMobile ? '8px' : '16px',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid #f3f4f6'
          }}>
            <span style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '4px',
              color: '#15803d', 
              fontSize: '13px', 
              fontWeight: 600 
            }}>
              {'🏷️'} Entrega: {fixedEnabled && !mapboxEnabled ? 'taxa por bairro' : <>{mapboxEnabled && perKm > 0 ? 'a partir de ' : ''}{fmt(config.deliveryFee)}</>}
            </span>
            <span style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '4px',
              color: storeStatus.open ? '#16a34a' : '#dc2626',
              fontSize: '13px',
              fontWeight: 500
            }}>
              <span style={{ 
                width: '8px', 
                height: '8px', 
                borderRadius: '50%', 
                backgroundColor: storeStatus.open ? '#22c55e' : '#ef4444',
                display: 'inline-block'
              }}></span>
              {storeStatus.text}
            </span>
          </div>
            </>
          )}
        </div>
      </div>

      {/* Category Navigation - Mobile Optimized */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        backgroundColor: '#f3f4f6',
        marginTop: '16px'
      }}>
        <div style={{ 
          maxWidth: '896px', 
          margin: '0 auto',
          padding: isMobile ? '10px 12px' : '12px 16px'
        }}>
          <div style={{
            display: 'flex',
            overflowX: 'auto',
            gap: '8px',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none'
          }}>
            <style>{`div::-webkit-scrollbar { display: none; }`}</style>
            {sortedCategories.map(cat => (
              <button
                key={cat.id}
                onClick={() => scrollToCategory(cat.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: isMobile ? '8px 14px' : '10px 18px',
                  borderRadius: '24px',
                  fontSize: isMobile ? '13px' : '14px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  backgroundColor: activeCategory === cat.id ? (config.menuCategory || '#d9273f') : tint(config.menuCategory, 0.1),
                  color: activeCategory === cat.id ? '#ffffff' : (config.menuCategory || '#54111e'),
                  boxShadow: activeCategory === cat.id ? '0 4px 12px rgba(217, 39, 63, 0.2)' : 'none',
                  flexShrink: 0
                }}
              >
                <span>{cat.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Menu Content */}
      <div style={{ 
        maxWidth: '896px', 
        margin: '0 auto', 
        padding: isMobile ? '16px 12px 100px' : '24px 16px 100px'
      }}>
        {sortedCategories.map(category => {
          const categoryProducts = availableProducts.filter(p => p.categoryId === category.id)
          if (categoryProducts.length === 0) return null
          return (
            <section
              key={category.id}
              ref={el => { sectionRefs.current[category.id] = el }}
              style={{ marginBottom: isMobile ? '24px' : '32px' }}
            >
              <h3 style={{
                fontSize: isMobile ? '18px' : '22px',
                fontWeight: 'bold',
                color: config.menuTitle || '#1f2937',
                marginBottom: isMobile ? '12px' : '16px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                {category.name}
                <span style={{ 
                  fontSize: '13px', 
                  color: '#9ca3af', 
                  fontWeight: 400,
                  marginLeft: '4px'
                }}>
                  ({categoryProducts.length})
                </span>
              </h3>
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
                alignItems: 'stretch',
                gap: isMobile ? '12px' : '18px'
              }}>
                {categoryProducts.map(product => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    quantity={getCartQuantity(product.id)}
                    onAdd={() => {
                      // "Adicionar" entra direto no carrinho sem abrir nova página;
                      // os extras podem ser escolhidos depois pelo link na linha do carrinho
                      addToCart(product, [], true)
                    }}
                    onRemove={() => removeFromCart(product.id)}
                    onClick={() => openProductModal(product)}
                    isMobile={isMobile}
                  />
                ))}
              </div>
            </section>
          )
        })}

        {/* Delivery Zones Info */}
        {fixedEnabled && deliveryZones.length > 0 && (
          <section style={{ marginBottom: '24px' }}>
            <h3 style={{
              fontSize: isMobile ? '18px' : '22px',
              fontWeight: 'bold',
              color: config.menuTitle || '#1f2937',
              marginBottom: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              
              Áreas de Entrega
            </h3>
            <div style={{
              backgroundColor: 'white',
              borderRadius: '12px',
              padding: '12px',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
            }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)',
                gap: '8px'
              }}>
                {deliveryZones.map(zone => (
                  <div key={zone.id} style={{
                    backgroundColor: '#f9fafb',
                    borderRadius: '10px',
                    padding: '12px',
                    textAlign: 'center'
                  }}>
                    <p style={{ fontWeight: 600, color: config.menuTitle || '#1f2937', fontSize: '13px', margin: 0 }}>{zone.name}</p>
                    <p style={{ color: '#15803d', fontWeight: 'bold', fontSize: '14px', margin: '4px 0 0 0' }}>
                      {money(zone.price)}
                    </p>
                    <p style={{ fontSize: '11px', color: config.menuDescription || '#6b7280', margin: '2px 0 0 0' }}>{zone.estimatedTime}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Floating Cart Button - Mobile Optimized */}
      {totalItems > 0 && (
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 30,
          padding: isMobile ? '12px' : '16px',
          background: 'linear-gradient(to top, rgba(243, 244, 246, 1) 70%, rgba(243, 244, 246, 0))',
          pointerEvents: 'none'
        }}>
          <div style={{ maxWidth: '896px', margin: '0 auto', pointerEvents: 'auto' }}>
            <button
              onClick={() => setShowCart(true)}
              style={{
                width: '100%',
                backgroundColor: config.menuButton || '#d9273f',
                color: '#ffffff',
                borderRadius: '14px',
                padding: isMobile ? '14px 16px' : '16px 24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                boxShadow: '0 10px 25px rgba(217, 39, 63, 0.28)',
                border: 'none',
                cursor: 'pointer',
                transition: 'transform 0.1s'
              }}
              onMouseDown={e => e.currentTarget.style.transform = 'scale(0.98)'}
              onMouseUp={e => e.currentTarget.style.transform = 'scale(1)'}
              onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.25)',
                  borderRadius: '8px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}>
                  {totalItems}
                </span>
                <span style={{ fontWeight: 600, fontSize: isMobile ? '14px' : '16px' }}>
                  Ver carrinho
                </span>
              </div>
              <span style={{ fontWeight: 'bold', fontSize: isMobile ? '16px' : '18px' }}>
                {money(totalPrice)}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Cart Modal - Mobile Fullscreen */}
      {showCart && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: isMobile ? 'flex-end' : 'center',
          justifyContent: 'center'
        }}>
          <div 
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
            onClick={() => setShowCart(false)}
          ></div>
          <div style={{
            position: 'relative',
            backgroundColor: 'white',
            borderRadius: isMobile ? '20px 20px 0 0' : '20px',
            width: '100%',
            maxWidth: '500px',
            maxHeight: isMobile ? '90vh' : '80vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'slideUp 0.3s ease-out'
          }}>
            <style>{`
              @keyframes slideUp {
                from { transform: translateY(100%); }
                to { transform: translateY(0); }
              }
            `}</style>
            {/* Handle bar for mobile */}
            {isMobile && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 4px' }}>
                <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px' }}></div>
              </div>
            )}
            <div style={{ padding: isMobile ? '12px 16px' : '20px', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '18px', fontWeight: 'bold', color: config.menuTitle || '#1f2937', margin: 0 }}>
                  Seu Pedido
                </h3>
                <button 
                  onClick={() => setShowCart(false)}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: '#f3f4f6',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '16px'
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px' : '20px' }}>
              {cart.map(item => (
                <div key={item.product.id + '|' + (item.selectedAddOns || []).map(a => a.id).sort().join(',')} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 0',
                  borderBottom: '1px solid #f9fafb'
                }}>
                  {item.product.image && (
                    <img 
                      src={item.product.image} 
                      alt={item.product.name}
                      style={{
                        width: '48px',
                        height: '48px',
                        borderRadius: '8px',
                        objectFit: 'cover',
                        flexShrink: 0
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ 
                      fontWeight: 500, 
                      color: config.menuTitle || '#1f2937', 
                      fontSize: '14px',
                      margin: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>
                      {item.product.name}
                    </p>
                    {(item.product.addOns || []).length > 0 && (
                      <div style={{ margin: '6px 0 2px 0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: config.menuDescription || '#6b7280' }}>Adicionais:</p>
                        {item.product.addOns.map(addOn => {
                          const checked = (item.selectedAddOns || []).some(a => a.id === addOn.id)
                          return (
                            <label
                              key={addOn.id}
                              style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: '#374151', cursor: 'pointer', padding: '3px 0' }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleCartItemAddOn(item, addOn.id)}
                                style={{ accentColor: accent, width: '20px', height: '20px', cursor: 'pointer', flexShrink: 0 }}
                              />
                              <span>{addOn.name}</span>
                              <span style={{ color: '#15803d', fontWeight: 700, fontSize: '15px', whiteSpace: 'nowrap' }}>+ {fmt(addOn.price)}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                    <p style={{ 
                      color: accent, 
                      fontWeight: 600, 
                      fontSize: '13px',
                      margin: '2px 0 0 0'
                    }}>
                      {money(getItemUnitPrice(item) * item.quantity)}
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                      onClick={() => removeFromCart(item.product.id, (item.selectedAddOns || []).map(a => a.id))}
                      style={{
                        width: '30px',
                        height: '30px',
                        borderRadius: '50%',
                        border: `1.5px solid ${accent}`,
                        color: accent,
                        backgroundColor: 'white',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                        fontWeight: 'bold'
                      }}
                    >
                      −
                    </button>
                    <span style={{ width: '20px', textAlign: 'center', fontWeight: 600, fontSize: '14px' }}>
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => addToCart(item.product, (item.selectedAddOns || []).map(a => a.id), true)}
                      style={{
                        width: '30px',
                        height: '30px',
                        borderRadius: '50%',
                        border: 'none',
                        backgroundColor: accent,
                        color: 'white',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                        fontWeight: 'bold'
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div style={{
              padding: isMobile ? '16px' : '20px',
              borderTop: '1px solid #f3f4f6',
              backgroundColor: '#fafafa'
            }}>
              <div style={{ marginBottom: '10px' }}>
                {discount > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '8px 10px' }}>
                    <span style={{ fontSize: '13px', color: '#166534', fontWeight: 600 }}>🏷️ Cupom {activeCouponCode} aplicado</span>
                    <button onClick={removeCoupon} style={{ background: 'none', border: 'none', color: '#b91c1c', fontSize: '12px', cursor: 'pointer' }}>Remover</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        value={couponInput}
                        onChange={e => { setCouponInput(e.target.value.toUpperCase()); setCouponMsg('') }}
                        onKeyDown={e => { if (e.key === 'Enter') applyCoupon() }}
                        placeholder="Cupom de desconto"
                        style={{ flex: 1, minWidth: 0, border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px 12px', fontSize: '14px', textTransform: 'uppercase' }}
                      />
                      <button onClick={applyCoupon} style={{ background: '#1f2937', color: 'white', border: 'none', borderRadius: '10px', padding: '0 16px', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}>Aplicar</button>
                    </div>
                    {(couponMsg || (appliedCode && couponCheck && !couponCheck.ok)) && (
                      <p style={{ margin: '6px 0 0', fontSize: '12px', color: '#b91c1c' }}>{couponMsg || (couponCheck && !couponCheck.ok ? couponCheck.message : '')}</p>
                    )}
                  </>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ color: config.menuDescription || '#6b7280', fontSize: '13px' }}>Subtotal</span>
                <span style={{ fontWeight: 600, fontSize: '13px' }}>{fmt(totalPrice)}</span>
              </div>
              {discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: '#16a34a', fontSize: '13px' }}>Desconto</span>
                  <span style={{ fontWeight: 600, fontSize: '13px', color: '#16a34a' }}>- {fmt(discount)}</span>
                </div>
              )}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                paddingTop: '12px',
                borderTop: '1px solid #e5e7eb',
                marginBottom: '12px'
              }}>
                <span style={{ fontSize: '16px', fontWeight: 'bold', color: config.menuTitle || '#1f2937' }}>Total</span>
                <span style={{ fontSize: '16px', fontWeight: 'bold', color: config.menuTitle || '#1f2937' }}>
                  {fmt(totalPrice)}
                </span>
              </div>
              <p style={{ color: '#9ca3af', fontSize: '11px', margin: '0 0 10px 0', textAlign: 'center' }}>
                Entrega ou retirada e forma de pagamento você escolhe a seguir
              </p>
              <button
                onClick={openCheckout}
                disabled={cart.length === 0}
                style={{
                  width: '100%',
                  backgroundColor: cart.length === 0 ? '#d1d5db' : accent,
                  color: 'white',
                  borderRadius: '12px',
                  padding: '14px',
                  fontWeight: 'bold',
                  fontSize: '15px',
                  border: 'none',
                  cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
                  boxShadow: cart.length === 0 ? 'none' : `0 4px 12px ${accentShadow}`
                }}
              >
                Finalizar pedido
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout Modal - aparece após "Finalizar pedido" */}
      {showCheckout && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50, display: 'flex',
          alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center'
        }}>
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,.52)' }} onClick={() => setShowCheckout(false)} />
          <div style={{
            position: 'relative', backgroundColor: 'white',
            borderRadius: isMobile ? '20px 20px 0 0' : '20px',
            width: '100%', maxWidth: '540px', maxHeight: isMobile ? '98dvh' : '94vh', height: isMobile ? '98dvh' : undefined, overflow: 'hidden',
            display: 'flex', flexDirection: 'column', animation: 'slideUp .25s ease-out'
          }}>
            {isMobile && <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 0' }}><div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px' }} /></div>}
            <div style={{ padding: isMobile ? '8px 16px 10px' : '20px 24px 16px', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div>
                  <h3 style={{ fontSize: '19px', fontWeight: 800, color: config.menuTitle || '#1f2937', margin: 0 }}>Finalizar pedido</h3>
                  <p style={{ margin: '4px 0 0', fontSize: '12px', color: config.menuDescription || '#6b7280' }}>Etapa {checkoutStep} de 3 • Leva só alguns instantes</p>
                </div>
                <button onClick={() => setShowCheckout(false)} aria-label="Fechar finalização" style={{ width: '34px', height: '34px', borderRadius: '10px', background: '#f3f4f6', color: '#4b5563', border: 'none', cursor: 'pointer', fontSize: '18px' }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px', marginTop: isMobile ? '8px' : '18px' }}>
                {[
                  { number: 1, title: 'Seus dados', subtitle: 'Contato e entrega' },
                  { number: 2, title: 'Pagamento', subtitle: 'Como vai pagar' },
                  { number: 3, title: 'Revisão', subtitle: 'Confira o pedido' },
                ].map(step => (
                  <div key={step.number} style={{ minWidth: 0 }}>
                    <div style={{ height: '4px', borderRadius: '99px', background: checkoutStep >= step.number ? (config.menuButton || '#d9273f') : '#e5e7eb', marginBottom: isMobile ? '4px' : '8px' }} />
                    <div style={{ fontSize: '12px', fontWeight: 750, color: checkoutStep === step.number ? (config.menuButton || '#d9273f') : checkoutStep > step.number ? '#374151' : '#9ca3af' }}>{step.number}. {step.title}</div>
                    {!isMobile && <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px' }}>{step.subtitle}</div>}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? '16px' : '20px 24px' }}>
              {checkoutStep === 1 && (
                <>
              {/* Nome e telefone */}
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                Seu nome *
              </label>
              <input
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                placeholder="Como podemos te chamar?"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                  border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '14px', outline: 'none'
                }}
              />
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                Telefone / WhatsApp *
              </label>
              <input
                value={customerPhone}
                onChange={e => setCustomerPhone(e.target.value)}
                placeholder="(00) 00000-0000"
                inputMode="tel"
                style={{
                  width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                  border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '18px', outline: 'none'
                }}
              />

              {/* Retirada ou entrega */}
              <p style={{ fontSize: '13px', fontWeight: 600, color: '#374151', margin: '0 0 8px 0' }}>
                Como deseja receber seu pedido? *
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: pickupEnabled ? '1fr 1fr' : '1fr', gap: '8px', marginBottom: '10px' }}>
                {[
                  ...(pickupEnabled ? [{ value: 'pickup' as DeliveryType, title: 'Retirar no local', desc: config.address || 'No endereço da loja' }] : []),
                  { value: 'delivery' as DeliveryType, title: 'Entrega', desc: fixedEnabled && !mapboxEnabled ? 'Taxa por bairro' : (mapboxEnabled && perKm > 0 ? `${fmt(config.deliveryFee)} + ${fmt(perKm)}/km` : `${fmt(config.deliveryFee)} taxa`) },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDeliveryType(opt.value)}
                    style={{
                      padding: '7px 8px',
                      borderRadius: '10px',
                      border: deliveryType === opt.value ? `2px solid ${accent}` : '1px solid #e5e7eb',
                      backgroundColor: deliveryType === opt.value ? accentSoft : 'white',
                      cursor: 'pointer',
                      textAlign: 'center'
                    }}
                  >
                    
                    <span style={{ fontWeight: 600, fontSize: '13px', color: config.menuTitle || '#1f2937', display: 'block' }}>{opt.title}</span>
                    <span style={{ fontSize: '10px', lineHeight: 1.25, display: 'block', color: config.menuDescription || '#6b7280' }}>{opt.desc}</span>
                  </button>
                ))}
              </div>

              {deliveryType === 'pickup' && (
                <p style={{ fontSize: '12px', color: config.menuDescription || '#6b7280', backgroundColor: '#f9fafb', padding: '10px 12px', borderRadius: '10px', margin: '0 0 18px 0' }}>
                  Retirada na loja: <strong>{config.address || 'consulte o endereço'}</strong>
                </p>
              )}
              {deliveryType === 'delivery' && (
                <div style={{ marginBottom: '18px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    CEP
                  </label>
                  <input
                    value={cep}
                    onChange={e => handleCepChange(e.target.value)}
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={9}
                    placeholder="00000-000"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '4px', outline: 'none'
                    }}
                  />
                  {cepMessage && (
                    <p style={{
                      fontSize: '12px', margin: '0 0 10px 0',
                      color: cepStatus === 'ok' ? '#15803d' : cepStatus === 'error' ? '#dc2626' : '#6b7280'
                    }}>
                      {cepMessage}
                    </p>
                  )}
                  <div style={{ height: cepMessage ? 0 : '6px' }} />
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    Rua *{locked.street ? ' (preenchida pelo CEP)' : ''}
                  </label>
                  <input
                    value={addrStreet}
                    onChange={e => setAddrStreet(e.target.value)}
                    readOnly={locked.street}
                    placeholder="Nome da rua"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '10px', outline: 'none',
                      backgroundColor: locked.street ? '#f3f4f6' : 'white',
                      color: locked.street ? '#4b5563' : '#111827',
                      cursor: locked.street ? 'not-allowed' : 'text'
                    }}
                  />
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    Bairro{fixedEnabled ? ' *' : ''}{locked.neighborhood ? ' (preenchido pelo CEP)' : ''}
                  </label>
                  <input
                    value={addrNeighborhood}
                    onChange={e => setAddrNeighborhood(e.target.value)}
                    readOnly={locked.neighborhood}
                    placeholder="Bairro"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '10px', outline: 'none',
                      backgroundColor: locked.neighborhood ? '#f3f4f6' : 'white',
                      color: locked.neighborhood ? '#4b5563' : '#111827',
                      cursor: locked.neighborhood ? 'not-allowed' : 'text'
                    }}
                  />
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    Cidade / UF{locked.city ? ' (preenchida pelo CEP)' : ''}
                  </label>
                  <input
                    value={addrCity}
                    onChange={e => setAddrCity(e.target.value)}
                    readOnly={locked.city}
                    placeholder="Ex.: Joinville - SC"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '10px', outline: 'none',
                      backgroundColor: locked.city ? '#f3f4f6' : 'white',
                      color: locked.city ? '#4b5563' : '#111827',
                      cursor: locked.city ? 'not-allowed' : 'text'
                    }}
                  />
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    Número e complemento *
                  </label>
                  <input
                    ref={numberInputRef}
                    value={customerNumber}
                    onChange={e => setCustomerNumber(e.target.value)}
                    placeholder="Ex.: 123, apto 4"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', marginBottom: '8px', outline: 'none'
                    }}
                  />
                  {useDistanceFreight && freight.status !== 'idle' && (
                    <p style={{
                      fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0',
                      color: freight.status === 'ok' ? '#15803d' : freight.status === 'loading' ? '#6b7280' : freight.status === 'out' ? '#dc2626' : '#b45309'
                    }}>
                      {freight.status === 'loading' && 'Calculando frete...'}
                      {freight.status === 'ok' && `Distância: ${freight.km.toFixed(1).replace('.', ',')} km • Frete: ${fmt(freight.fee)}`}
                      {freight.status === 'out' && `Endereço fora da área de entrega (máximo ${maxKm} km).`}
                      {freight.status === 'error' && `Não foi possível calcular a distância. Será cobrada a taxa base de ${fmt(config.deliveryFee)}.`}
                    </p>
                  )}
                  {matchedZone && (
                    <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0', color: '#15803d' }}>
                      {`Bairro ${matchedZone.name} • Taxa fixa: ${fmt(matchedZone.price)}`}
                    </p>
                  )}
                  {fixedOnlyNoMatch && (
                    <p style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 8px 0', color: '#dc2626' }}>
                      {addrNeighborhood.trim() ? `Não entregamos no bairro "${addrNeighborhood.trim()}".` : 'Informe o bairro para calcular a taxa de entrega.'}
                    </p>
                  )}
                  {fixedEnabled && deliveryZones.length > 0 && (
                    <p style={{ fontSize: '11px', color: '#9ca3af', margin: 0 }}>
                      Bairros atendidos: {deliveryZones.map(z => z.name).join(', ')}
                    </p>
                  )}
                </div>
              )}
              {(schedulingEnabled || productScheduleRequired) && (
                <div style={{ marginBottom: '18px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 600, color: '#374151', margin: '0 0 8px 0' }}>
                    Quando? *
                  </p>
                  {mustSchedule ? (
                    <p style={{ fontSize: '12px', color: '#92400e', backgroundColor: '#fffbeb', border: '1px solid #fde68a', padding: '10px 12px', borderRadius: '10px', margin: '0 0 10px 0' }}>
                      {productScheduleRequired
                        ? 'Seu carrinho contém produto(s) com dias de entrega específicos. Escolha uma data permitida para continuar.'
                        : `A loja está fechada agora (${storeStatus.text.replace('Fechado • ', '').replace('Fechado', 'fora do horário')}). Você pode encomendar e agendar para um horário em que a loja estiver aberta.`}
                    </p>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                      {[{ v: 'now', t: 'Agora' }, { v: 'schedule', t: 'Agendar' }].map(o => (
                        <button key={o.v} type="button" onClick={() => setWhenMode(o.v as any)}
                          style={{
                            padding: '12px 8px', borderRadius: '12px', cursor: 'pointer', fontWeight: 600, fontSize: '14px', color: config.menuTitle || '#1f2937',
                            border: whenMode === o.v ? `2px solid ${accent}` : '1px solid #e5e7eb',
                            backgroundColor: whenMode === o.v ? accentSoft : 'white'
                          }}>{o.t}</button>
                      ))}
                    </div>
                  )}
                  {scheduling && (scheduleDays.length === 0 ? (
                    <p style={{ fontSize: '12px', color: '#dc2626', margin: 0 }}>Não há horários disponíveis nos dias permitidos para este carrinho.</p>
                  ) : (
                    <>
                      <label style={{ display: 'block', fontSize: '12px', color: config.menuDescription || '#6b7280', marginBottom: '4px' }}>Dia</label>
                      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', marginBottom: '8px' }}>
                        {scheduleDays.map(d => (
                          <button key={d.date} type="button" onClick={() => { setSchedDate(d.date); setSchedTime('') }}
                            style={{
                              flexShrink: 0, padding: '8px 14px', borderRadius: '999px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                              border: schedDate === d.date ? `2px solid ${accent}` : '1px solid #e5e7eb',
                              backgroundColor: schedDate === d.date ? accentSoft : 'white', color: config.menuTitle || '#1f2937'
                            }}>{d.label}</button>
                        ))}
                      </div>
                      {selectedDay && (
                        <>
                          <label style={{ display: 'block', fontSize: '12px', color: config.menuDescription || '#6b7280', marginBottom: '4px' }}>Horário</label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {selectedDay.times.map(t => (
                              <button key={t} type="button" onClick={() => setSchedTime(t)}
                                style={{
                                  padding: '8px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
                                  border: schedTime === t ? `2px solid ${accent}` : '1px solid #e5e7eb',
                                  backgroundColor: schedTime === t ? accentSoft : 'white', color: config.menuTitle || '#1f2937'
                                }}>{t}</button>
                            ))}
                          </div>
                        </>
                      )}
                      {selectedDay && incompatibleProducts.length > 0 && (
                        <div role="alert" style={{ color: '#991b1b', backgroundColor: '#fef2f2', border: '1px solid #fecaca', padding: '10px 12px', borderRadius: '10px', margin: '10px 0 0' }}>
                          <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '6px' }}>
                            {incompatibleProducts.map(product => (
                              <li key={product.id} style={{ lineHeight: 1.4 }}>
                                <strong>{product.name}</strong>
                                <span style={{ display: 'block', marginTop: '2px', fontSize: '11px', color: '#7f1d1d' }}>Disponível: {formatProductDeliveryDays(product)}</span>
                              </li>
                            ))}
                          </ul>
                          <p style={{ margin: '10px 0 0', paddingTop: '8px', borderTop: '1px solid #fecaca', fontSize: '12px', fontWeight: 600, lineHeight: 1.4 }}>
                            Retire este produto do carrinho ou escolha outra data!
                          </p>
                        </div>
                      )}
                      {!scheduleOk && incompatibleProducts.length === 0 && <p style={{ fontSize: '12px', color: config.menuDescription || '#6b7280', margin: '8px 0 0' }}>Escolha o dia e o horário.</p>}
                    </>
                  ))}
                </div>
              )}
                </>
              )}
              {checkoutStep === 2 && (
                <>
              {/* Forma de pagamento */}
              <p style={{ fontSize: '13px', fontWeight: 600, color: '#374151', margin: '0 0 8px 0' }}>
                Forma de pagamento *
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '14px' }}>
                {([
                  { value: 'card' as PaymentMethod, title: 'Cartão' },
                  { value: 'pix' as PaymentMethod, title: 'PIX' },
                  { value: 'cash' as PaymentMethod, title: 'Dinheiro' },
                ]).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPaymentMethod(opt.value)}
                    style={{
                      padding: '12px 8px',
                      borderRadius: '12px',
                      border: paymentMethod === opt.value ? `2px solid ${accent}` : '1px solid #e5e7eb',
                      backgroundColor: paymentMethod === opt.value ? accentSoft : 'white',
                      cursor: 'pointer',
                      textAlign: 'center'
                    }}
                  >
                    
                    <span style={{ fontWeight: 600, fontSize: '13px', color: config.menuTitle || '#1f2937' }}>{opt.title}</span>
                  </button>
                ))}
              </div>
              {paymentMethod === 'card' && (
                <p style={{ fontSize: '12px', color: config.menuDescription || '#6b7280', backgroundColor: '#f9fafb', padding: '10px 12px', borderRadius: '10px', margin: '0 0 18px 0' }}>
                  O cartão é passado na entrega{deliveryType === 'pickup' ? ' na retirada' : ''} pela nossa equipe.
                </p>
              )}
              {paymentMethod === 'pix' && (
                <p style={{ fontSize: '12px', color: config.menuDescription || '#6b7280', backgroundColor: '#f9fafb', padding: '10px 12px', borderRadius: '10px', margin: '0 0 18px 0' }}>
                  {config.pixKey
                    ? 'Ao finalizar o pedido você verá o QR Code do Pix para pagar.'
                    : `Você receberá a chave PIX pelo WhatsApp (${config.phone || 'telefone da loja'}) após finalizar o pedido.`}
                </p>
              )}
              {paymentMethod === 'cash' && (
                <div style={{ marginBottom: '18px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '4px' }}>
                    Precisa de troco para quanto? (opcional)
                  </label>
                  <input
                    value={changeFor}
                    onChange={e => setChangeFor(e.target.value)}
                    placeholder={`Ex.: ${fmt(Math.ceil(checkoutTotal / 10) * 10)}`}
                    inputMode="decimal"
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '10px',
                      border: '1px solid #e5e7eb', fontSize: '14px', outline: 'none'
                    }}
                  />
                  {changeValue > checkoutTotal && (
                    <p style={{ fontSize: '12px', color: '#16a34a', marginTop: '6px' }}>
                      Troco de {fmt(changeValue - checkoutTotal)}
                    </p>
                  )}
                </div>
              )}
                </>
              )}
              {checkoutStep === 3 && (
                <div>
                  <h4 style={{ margin: '0 0 12px', fontSize: '16px', color: config.menuTitle || '#1f2937' }}>Confira os dados antes de confirmar</h4>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
                    <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 800, color: '#374151' }}>Cliente</p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#4b5563' }}>{customerName}</p>
                    <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#4b5563' }}>{customerPhone}</p>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
                    <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 800, color: '#374151' }}>Recebimento</p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#4b5563' }}>{deliveryType === 'delivery' ? 'Entrega no endereço' : 'Retirada no local'}</p>
                    {deliveryType === 'delivery' && <p style={{ margin: '4px 0 0', fontSize: '13px', lineHeight: 1.5, color: '#4b5563' }}>{customerAddress}, nº {customerNumber}{cep.length === 9 ? ' • CEP ' + cep : ''}</p>}
                    {deliveryType === 'pickup' && <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#4b5563' }}>{config.address || 'Endereço da loja'}</p>}
                    {scheduling && <p style={{ margin: '6px 0 0', fontSize: '13px', fontWeight: 700, color: '#92400e' }}>🗓️ Agendado: {formatScheduled(schedDate, schedTime)}</p>}
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: '14px', padding: '14px', marginBottom: '12px' }}>
                    <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 800, color: '#374151' }}>Pagamento</p>
                    <p style={{ margin: 0, fontSize: '13px', color: '#4b5563' }}>{paymentMethod ? paymentLabels[paymentMethod as PaymentMethod] : 'Não selecionado'}{paymentMethod === 'cash' && changeValue > checkoutTotal ? ' • Troco para ' + fmt(changeValue) : ''}</p>
                  </div>
                  <div style={{ border: '1px solid #f3d0d5', background: '#fff7f8', borderRadius: '14px', padding: '14px' }}>
                    <p style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 800, color: config.menuTitle || '#54111e' }}>Itens do pedido ({totalItems})</p>
                    {cart.map((item, index) => (
                      <div key={item.product.id + '-' + index} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', fontSize: '13px', color: '#4b5563' }}>
                        <span>{item.quantity}× {item.product.name}{(item.selectedAddOns || []).length ? ' + ' + item.selectedAddOns.map(a => a.name).join(', ') : ''}</span>
                        <strong style={{ whiteSpace: 'nowrap' }}>{fmt(getItemUnitPrice(item) * item.quantity)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: isMobile ? '10px 16px 14px' : '16px 24px 22px', borderTop: '1px solid #f3f4f6', background: '#fafafa' }}>
              {checkoutStep === 3 && <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '13px', color: config.menuDescription || '#6b7280' }}>
                <span>Subtotal</span><strong style={{ color: '#374151' }}>{fmt(totalPrice)}</strong>
              </div>
              {discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '13px', color: '#15803d' }}><span>Desconto ({activeCouponCode})</span><strong>− {fmt(discount)}</strong></div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px', fontSize: '13px', color: config.menuDescription || '#6b7280' }}>
                <span>{deliveryType === 'delivery' ? 'Taxa de entrega' : 'Retirada no local'}</span><strong style={{ color: '#374151' }}>{deliveryType === 'delivery' ? deliveryFeeLabel : 'Grátis'}</strong>
              </div>
              </>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: checkoutStep === 3 ? '10px' : 0, borderTop: checkoutStep === 3 ? '1px solid #e5e7eb' : 'none', marginBottom: '10px' }}>
                <span style={{ fontSize: '16px', fontWeight: 800, color: config.menuTitle || '#1f2937' }}>Total do pedido</span>
                <span style={{ fontSize: '20px', fontWeight: 850, color: config.menuPrice || '#d9273f' }}>{fmt(checkoutTotal)}</span>
              </div>
                                          <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" onClick={() => checkoutStep === 1 ? (setShowCheckout(false), setShowCart(true)) : setCheckoutStep(checkoutStep - 1)} style={{ flex: '0 0 34%', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: '10px', padding: '8px 10px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>{checkoutStep === 1 ? 'Voltar ao carrinho' : 'Voltar'}</button>
                {checkoutStep < 3 ? (
                  <button type="button" onClick={() => { if (checkoutStep === 1 && canContinueCheckoutStep1) setCheckoutStep(2); else if (checkoutStep === 2 && paymentMethod) setCheckoutStep(3) }} disabled={checkoutStep === 1 ? !canContinueCheckoutStep1 : !paymentMethod} style={{ flex: 1, background: (checkoutStep === 1 ? canContinueCheckoutStep1 : !!paymentMethod) ? (config.menuButton || '#d9273f') : '#d1d5db', color: '#fff', border: 'none', borderRadius: '10px', padding: '9px 12px', fontWeight: 800, fontSize: '14px', cursor: (checkoutStep === 1 ? canContinueCheckoutStep1 : !!paymentMethod) ? 'pointer' : 'not-allowed' }}>Continuar <span aria-hidden="true">→</span></button>
                ) : (
                  <button type="button" onClick={placeOrder} disabled={!canPlaceOrder || placingOrder} style={{ flex: 1, background: canPlaceOrder && !placingOrder ? (config.menuButton || '#d9273f') : '#d1d5db', color: '#fff', border: 'none', borderRadius: '10px', padding: '9px 12px', fontWeight: 800, fontSize: '14px', cursor: canPlaceOrder ? 'pointer' : 'not-allowed' }}>{placingOrder ? 'Enviando pedido…' : 'Confirmar pedido'}</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      
{/* Confirmação de pedido */}
      {orderPlaced && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px'
        }}>
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)' }}></div>
          <div style={{
            position: 'relative',
            backgroundColor: 'white',
            borderRadius: '20px',
            width: '100%',
            maxWidth: '400px',
            maxHeight: '92vh',
            overflowY: 'auto',
            padding: '28px 20px',
            textAlign: 'center',
            animation: 'slideUp 0.3s ease-out'
          }}>
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%', backgroundColor: '#dcfce7',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 14px', fontSize: '30px'
            }}>
              ✅
            </div>
            <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: config.menuTitle || '#1f2937', margin: '0 0 6px' }}>
              Pedido enviado!
            </h3>
            <p style={{ color: config.menuDescription || '#6b7280', fontSize: '14px', margin: '0 0 16px' }}>
              Seu pedido <strong>{formatOrderNumber(orderPlaced)}</strong> foi registrado.
              {whatsappUrl ? ' Toque no botão abaixo para enviá-lo à loja pelo WhatsApp.' : ''}
            </p>
            <div style={{ backgroundColor: '#f9fafb', borderRadius: '12px', padding: '14px', textAlign: 'left', marginBottom: '18px' }}>
              <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 6px' }}>
                {orderPlaced.deliveryType === 'delivery' ? 'Entrega' : 'Retirada no local'}
                {orderPlaced.deliveryType === 'delivery' ? `: ${orderPlaced.customerAddress}` : ''}
              </p>
              {orderPlaced.scheduledDate && (
                <p style={{ fontSize: '13px', color: '#92400e', fontWeight: 700, margin: '0 0 6px' }}>
                  🗓️ Agendado para {formatScheduled(orderPlaced.scheduledDate, orderPlaced.scheduledTime)}
                </p>
              )}
              <p style={{ fontSize: '13px', color: '#374151', margin: '0 0 6px' }}>
                💰 Pagamento: {paymentLabels[orderPlaced.paymentMethod]}
                {orderPlaced.changeFor ? ` (troco para ${fmt(orderPlaced.changeFor)})` : ''}
              </p>
              <p style={{ fontSize: '13px', color: '#374151', margin: 0 }}>
                🧾 Total: <strong>{fmt(orderPlaced.total + orderPlaced.deliveryFee - (orderPlaced.discount || 0))}</strong>
              </p>
            </div>
            {orderPlaced.paymentMethod === 'pix' && config.pixKey && (
              <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px', marginBottom: '18px' }}>
                <p style={{ fontSize: '14px', fontWeight: 700, color: config.menuTitle || '#1f2937', margin: '0 0 10px' }}>
                  Pague com Pix: {fmt(orderPlaced.total + orderPlaced.deliveryFee - (orderPlaced.discount || 0))}
                </p>
                <PixQrCode
                  accentColor={accent}
                  payload={pixPayload(
                    config.pixKey,
                    config.pixHolder || config.name || '',
                    config.pixCity || '',
                    Math.round((orderPlaced.total + orderPlaced.deliveryFee - (orderPlaced.discount || 0)) * 100),
                  )}
                  pixKey={config.pixKey}
                  holder={config.pixHolder || config.name}
                />
              </div>
            )}
            {whatsappUrl ? (
              <>
                <button
                  onClick={sendOrderToWhatsApp}
                  style={{
                    width: '100%', backgroundColor: '#16a34a', color: 'white', borderRadius: '12px',
                    padding: '14px', fontWeight: 'bold', fontSize: '15px', border: 'none', cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(22, 163, 74, 0.3)'
                  }}
                >
                  Enviar pedido pelo WhatsApp
                </button>
                <button
                  onClick={() => setOrderPlaced(null)}
                  style={{
                    width: '100%', backgroundColor: 'transparent', color: config.menuDescription || '#6b7280', borderRadius: '12px',
                    padding: '10px', fontWeight: 600, fontSize: '13px', border: 'none', cursor: 'pointer', marginTop: '6px'
                  }}
                >
                  Voltar ao cardápio
                </button>
              </>
            ) : (
              <button
                onClick={() => setOrderPlaced(null)}
                style={{
                  width: '100%', backgroundColor: accent, color: 'white', borderRadius: '12px',
                  padding: '14px', fontWeight: 'bold', fontSize: '15px', border: 'none', cursor: 'pointer'
                }}
              >
                Voltar ao cardápio
              </button>
            )}
          </div>
        </div>
      )}

      {/* Product Detail Modal - Mobile Fullscreen */}
      {showProductModal && selectedProduct && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: isMobile ? 'flex-end' : 'center',
          justifyContent: 'center'
        }}>
          <div 
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
            onClick={() => { setShowProductModal(false); setEditingCartKey(null) }}
          ></div>
          <div style={{
            position: 'relative',
            backgroundColor: 'white',
            borderRadius: isMobile ? '20px 20px 0 0' : '20px',
            width: '100%',
            maxWidth: '500px',
            maxHeight: isMobile ? '92vh' : '85vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            animation: 'slideUp 0.3s ease-out'
          }}>
            {/* Handle bar for mobile */}
            {isMobile && (
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                padding: '10px 0 0',
                backgroundColor: 'white',
                position: 'relative',
                zIndex: 2
              }}>
                <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px' }}></div>
              </div>
            )}
            {/* Image */}
            <div style={{ 
              position: 'relative', 
              height: isMobile ? '200px' : '240px', 
              overflow: 'hidden',
              flexShrink: 0
            }}>
              {selectedProduct.image ? (
                <img 
                  src={selectedProduct.image} 
                  alt={selectedProduct.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <div style={{
                  width: '100%',
                  height: '100%',
                  background: `linear-gradient(135deg, ${tint(accent, 0.55)}, ${accent})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  
                </div>
              )}
              <button 
                onClick={() => { setShowProductModal(false); setEditingCartKey(null) }}
                style={{
                  position: 'absolute',
                  top: '12px',
                  right: '12px',
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  backgroundColor: 'white',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '16px'
                }}
              >
                ✕
              </button>
            </div>
            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '16px' : '24px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <h3 style={{ 
                  fontSize: isMobile ? '18px' : '22px', 
                  fontWeight: 'bold', 
                  color: config.menuTitle || '#1f2937',
                  margin: 0,
                  flex: 1
                }}>
                  {selectedProduct.name}
                </h3>
                {selectedProduct.popular && (
                  <span style={{
                    backgroundColor: '#fff7ed',
                    color: '#ea580c',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '3px 8px',
                    borderRadius: '12px',
                    whiteSpace: 'nowrap'
                  }}>
                    Popular
                  </span>
                )}
              </div>
              <p style={{ 
                color: config.menuDescription || '#6b7280', 
                marginTop: '10px', 
                fontSize: isMobile ? '13px' : '14px',
                lineHeight: 1.6,
                margin: '10px 0 0 0'
              }}>
                {selectedProduct.description}
              </p>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between', 
                marginTop: '20px'
              }}>
                <span style={{ fontSize: isMobile ? '22px' : '26px', fontWeight: 'bold', color: config.menuTitle || '#1f2937' }}>
                  {money(modalItemTotal)}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <button
                    onClick={() => removeFromCart(selectedProduct.id, selectedAddOns)}
                    style={{
                      width: '38px',
                      height: '38px',
                      borderRadius: '50%',
                      border: `2px solid ${accent}`,
                      color: accent,
                      backgroundColor: 'white',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '16px',
                      fontWeight: 'bold'
                    }}
                  >
                    −
                  </button>
                  <span style={{ width: '24px', textAlign: 'center', fontWeight: 'bold', fontSize: '18px' }}>
                    {getCartQuantity(selectedProduct.id)}
                  </span>
                  <button
                    onClick={() => addToCart(selectedProduct, selectedAddOns, true)}
                    style={{
                      width: '38px',
                      height: '38px',
                      borderRadius: '50%',
                      border: 'none',
                      backgroundColor: accent,
                      color: 'white',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '16px',
                      fontWeight: 'bold'
                    }}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Adicionais */}
              {selectedProduct.addOns && selectedProduct.addOns.length > 0 && (
                <div style={{ marginTop: '20px' }}>
                  <h4 style={{
                    fontSize: '15px',
                    fontWeight: 'bold',
                    color: config.menuTitle || '#1f2937',
                    margin: '0 0 8px 0',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}>
                    ➕ Adicione extras
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {selectedProduct.addOns.map(addOn => {
                      const checked = selectedAddOns.includes(addOn.id)
                      return (
                        <label
                          key={addOn.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '10px 12px',
                            borderRadius: '10px',
                            border: checked ? `2px solid ${accent}` : '1.5px solid #e5e7eb',
                            backgroundColor: checked ? accentSoft : 'white',
                            cursor: 'pointer',
                            transition: 'all 0.15s'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleAddOn(addOn.id)}
                            style={{ width: '18px', height: '18px', accentColor: accent, flexShrink: 0 }}
                          />
                          <span style={{ flex: 1, fontSize: '14px', color: '#374151', fontWeight: 500 }}>
                            {addOn.name}
                          </span>
                          <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#15803d', whiteSpace: 'nowrap' }}>
                            + {money(addOn.price)}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            <div style={{ 
              padding: isMobile ? '16px' : '20px', 
              borderTop: '1px solid #f3f4f6',
              backgroundColor: 'white'
            }}>
              <button 
                onClick={() => {
                  if (editingCartKey) { updateCartItemAddOns(); return }
                  addToCart(selectedProduct, selectedAddOns)
                  setShowProductModal(false)
                }}
                style={{
                  width: '100%',
                  backgroundColor: accent,
                  color: 'white',
                  borderRadius: '12px',
                  padding: '14px',
                  fontWeight: 'bold',
                  fontSize: '15px',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  boxShadow: `0 4px 12px ${accentShadow}`
                }}
              >
                {editingCartKey ? 'Salvar alterações' : (
                  <>
                    <span style={{ fontSize: '18px' }}>+</span>
                    Adicionar • {money(modalItemTotal)}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Product Card Component — catálogo visual, responsivo e acessível
function getProductFallbackImage(categoryId: string) {
  const images: Record<string, string> = {
    hamburgueres: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=85',
    combos: 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=900&q=85',
    acompanhamentos: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=900&q=85',
    sobremesas: 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=900&q=85',
    bebidas: 'https://images.unsplash.com/photo-1544145945-f90425340c7e?auto=format&fit=crop&w=900&q=85',
  }
  return images[categoryId] || images.hamburgueres
}

// Compatibilidade visual para produtos de demonstração antigos que usavam
// imagens genéricas repetidas. Fotos enviadas pelo estabelecimento são preservadas.
function getProductDisplayImage(product: Product) {
  // foto ainda chegando: não mostra a foto genérica no lugar (evita "piscar" e downloads à toa)
  if (product.imagePending) return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  const legacyPhotos: Record<string, string> = {
    'Tratto Duplo Cheddar': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=85',
    'Smash Bacon Crispy': 'https://images.unsplash.com/photo-1553979459-d2229ba7433a?auto=format&fit=crop&w=900&q=85',
    'Smash Tratto': 'https://images.unsplash.com/photo-1561758033-d89a9ad46330?auto=format&fit=crop&w=900&q=85',
    'Chicken Crispy Burger': 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?auto=format&fit=crop&w=900&q=85',
    'X-Burger Clássico': 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=900&q=85',
    'Combo Tratto Duplo': 'https://images.unsplash.com/photo-1550547660-d9450f859349?auto=format&fit=crop&w=900&q=85',
    'Combo Smash Bacon': 'https://images.unsplash.com/photo-1553979459-d2229ba7433a?auto=format&fit=crop&w=900&q=85',
    'Combo Família (4 pessoas)': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=85',
    'Batata Frita Média': 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=900&q=85',
    'Batata com Cheddar e Bacon': 'https://images.unsplash.com/photo-1639024471283-03518883512d?auto=format&fit=crop&w=900&q=85',
    'Onion Rings': 'https://images.unsplash.com/photo-1562967914-608f82629710?auto=format&fit=crop&w=900&q=85',
    'Nuggets (10 un)': 'https://images.unsplash.com/photo-1562967914-608f82629710?auto=format&fit=crop&w=900&q=85',
    'Brownie com Sorvete': 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=900&q=85',
    'Milkshake Ovomaltine': 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?auto=format&fit=crop&w=900&q=85',
    'Coca-Cola Lata 350ml': 'https://images.unsplash.com/photo-1629203851122-3726ecdf080e?auto=format&fit=crop&w=900&q=85',
    'Guaraná Antarctica Lata 350ml': 'https://images.unsplash.com/photo-1544145945-f90425340c7e?auto=format&fit=crop&w=900&q=85',
    'Suco Natural 500ml': 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=900&q=85',
    'Água Mineral 500ml': 'https://images.unsplash.com/photo-1564419320461-6870880221ad?auto=format&fit=crop&w=900&q=85',
  }
  if (product.image?.includes('image.qwenlm.ai')) return legacyPhotos[product.name] || getProductFallbackImage(product.categoryId)
  return product.image || getProductFallbackImage(product.categoryId)
}

function ProductCard({ product, quantity, onAdd, onRemove, onClick, isMobile }: {
  product: Product
  quantity: number
  onAdd: () => void
  onRemove: () => void
  onClick: () => void
  isMobile: boolean
}) {
  // ProductCard é um componente separado: precisa ler as cores do cardápio direto do contexto
  const { config } = useStore()
  const fallbackImage = getProductFallbackImage(product.categoryId)
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Ver detalhes de ${product.name}`}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{
        backgroundColor: '#fffdfa',
        borderRadius: '18px',
        border: '1px solid #eee4da',
        boxShadow: '0 5px 18px rgba(63, 37, 25, 0.055)',
        overflow: 'hidden',
        display: 'flex',
        minWidth: 0,
        minHeight: isMobile ? '136px' : '160px',
        cursor: 'pointer',
        transition: 'transform .18s ease, box-shadow .18s ease, border-color .18s ease',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = '0 12px 28px rgba(63, 37, 25, 0.11)'
        e.currentTarget.style.borderColor = '#d9b9a9'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = '0 5px 18px rgba(63, 37, 25, 0.055)'
        e.currentTarget.style.borderColor = '#eee4da'
      }}
    >
      <div style={{
        width: isMobile ? '116px' : '142px',
        minHeight: isMobile ? '136px' : '160px',
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
        background: '#f3e7dc',
      }}>
        <img
          src={getProductDisplayImage(product)}
          alt={product.name}
          loading="lazy"
          onError={e => {
            const img = e.currentTarget
            if (img.src !== fallbackImage) img.src = fallbackImage
            else img.onerror = null
          }}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            minHeight: isMobile ? '136px' : '160px',
            objectFit: 'cover',
            transition: 'transform .35s ease',
          }}
        />
        {product.popular && (
          <span style={{
            position: 'absolute', top: '9px', left: '9px',
            background: '#fff8ef', color: '#8a3b26',
            border: '1px solid rgba(138,59,38,.12)',
            borderRadius: '999px', padding: '4px 7px',
            fontSize: '10px', lineHeight: 1, fontWeight: 800,
            boxShadow: '0 2px 8px rgba(0,0,0,.08)',
          }}>★ MAIS PEDIDO</span>
        )}
        {quantity > 0 && (
          <span style={{
            position: 'absolute', right: '8px', bottom: '8px',
            background: config.menuButton || '#d9273f', color: '#ffffff',
            minWidth: '26px', height: '26px', padding: '0 6px',
            borderRadius: '999px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '12px', fontWeight: 800,
            boxShadow: '0 2px 8px rgba(0,0,0,.16)',
          }}>{quantity}x</span>
        )}
      </div>

      <div style={{
        flex: 1,
        minWidth: 0,
        padding: isMobile ? '11px 11px 10px 12px' : '15px 15px 13px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '8px',
      }}>
        <div>
          <h4 style={{
            fontWeight: 750, color: config.menuTitle || '#30231e',
            fontSize: isMobile ? '13px' : '15px',
            lineHeight: 1.3, margin: 0,
            letterSpacing: '-.015em',
          }}>{product.name}</h4>
          <p style={{
            color: config.menuDescription || '#776960',
            fontSize: isMobile ? '11px' : '12px',
            lineHeight: 1.45,
            margin: '5px 0 0',
            display: '-webkit-box',
            WebkitLineClamp: isMobile ? 3 : 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>{product.description}</p>
        </div>
        <div style={{
          display: 'flex', alignItems: 'flex-end',
          justifyContent: 'space-between', gap: '8px',
          flexWrap: 'wrap',
        }}>
          <span style={{
            color: config.menuPrice || '#d9273f', fontWeight: 850,
            fontSize: isMobile ? '15px' : '18px',
            lineHeight: 1.1, whiteSpace: 'nowrap',
            letterSpacing: '-.025em',
          }}>{fmt(product.price)}</span>
          <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
            {quantity > 0 ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                background: '#f8eee7', padding: '4px',
                borderRadius: '999px', border: '1px solid #ead8cc',
              }}>
                <button
                  type="button" aria-label={`Remover uma unidade de ${product.name}`}
                  onClick={onRemove}
                  style={{
                    width: '30px', height: '30px', borderRadius: '50%',
                    border: '1px solid #dfc5b6', color: config.menuPrice || '#d9273f',
                    background: '#fffdfa', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '18px', fontWeight: 600, padding: 0,
                  }}>−</button>
                <span style={{ minWidth: '14px', textAlign: 'center', fontWeight: 800, fontSize: '13px', color: '#54111e' }}>{quantity}</span>
                <button
                  type="button" aria-label={`Adicionar mais uma unidade de ${product.name}`}
                  onClick={onAdd}
                  style={{
                    width: '30px', height: '30px', borderRadius: '50%',
                    border: 'none', color: '#ffffff', background: config.menuButton || '#d9273f',
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', fontSize: '18px', fontWeight: 600, padding: 0,
                  }}>+</button>
              </div>
            ) : (
              <button
                type="button"
                aria-label={`Adicionar ${product.name} ao pedido`}
                onClick={e => { e.stopPropagation(); onAdd() }}
                style={{
                  border: 'none', color: '#ffffff',
                  background: config.menuButton || '#d9273f', borderRadius: '999px',
                  padding: isMobile ? '9px 12px' : '10px 15px',
                  fontSize: isMobile ? '11px' : '12px',
                  fontWeight: 750, cursor: 'pointer', whiteSpace: 'nowrap',
                  boxShadow: '0 3px 9px rgba(217, 39, 63,.16)',
                  minHeight: '36px',
                }}>+ Adicionar</button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

export default MenuView
