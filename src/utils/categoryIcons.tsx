import {
  TrendingUp, TrendingDown, Banknote, Users, Building2,
  Megaphone, Package, Landmark, Wifi, Plane, ArrowLeftRight,
  ShoppingCart, Car, Coffee, Heart, Utensils, BookOpen,
  Wrench, Briefcase, Home, Zap, DollarSign, CreditCard,
  Receipt, BarChart2, Gift, Globe, Shield, PiggyBank,
} from 'lucide-react'

const ICON_MAP: Record<string, React.ElementType> = {
  TrendingUp, TrendingDown, Banknote, Users, Building2,
  Megaphone, Package, Landmark, Wifi, Plane, ArrowLeftRight,
  ShoppingCart, Car, Coffee, Heart, Utensils, BookOpen,
  Wrench, Briefcase, Home, Zap, DollarSign, CreditCard,
  Receipt, BarChart2, Gift, Globe, Shield, PiggyBank,
}

interface Props {
  name: string
  size?: number
  color?: string
  className?: string
}

export default function CategoryIcon({ name, size = 16, color, className }: Props) {
  const Icon = ICON_MAP[name]

  // Legacy emoji fallback
  if (!Icon) {
    return <span className={className} style={{ fontSize: size, lineHeight: 1 }}>{name}</span>
  }

  return <Icon size={size} color={color} strokeWidth={1.5} className={className} />
}
