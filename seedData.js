export const DEFAULT_CATEGORIES = [
  {
    id: 'wedding',
    name: 'Wedding',
    iconName: 'Heart',
    image: 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'birthday',
    name: 'Birthday',
    iconName: 'Cake',
    image: 'https://images.unsplash.com/photo-1530103862676-de8c9debad1d?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'corporate',
    name: 'Corporate',
    iconName: 'Briefcase',
    image: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'festival',
    name: 'Festival',
    iconName: 'Sparkles',
    image: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'housewarming',
    name: 'Housewarming',
    iconName: 'Home',
    image: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'engagement',
    name: 'Engagement',
    iconName: 'Gift',
    image: 'https://images.unsplash.com/photo-1515934751635-c81c6bc9a2d8?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'anniversary',
    name: 'Anniversary',
    iconName: 'Award',
    image: 'https://images.unsplash.com/photo-1469371670807-013ccf25f16a?auto=format&fit=crop&q=80&w=400'
  },
  {
    id: 'baby-shower',
    name: 'Baby Shower',
    iconName: 'Smile',
    image: 'https://images.unsplash.com/photo-1519689680058-324335c77eb2?auto=format&fit=crop&q=80&w=400'
  }
];

export const DEFAULT_PROMOS = [
  {
    id: 'promo-1',
    title: 'Grand Winter Weddings 2026',
    subtitle: 'Get up to 25% bundle discount on Halls + Decorators',
    badge: 'Limited Offer',
    image: 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=800',
    gradient: 'from-pink-500/80 to-purple-600/80',
    tag: 'Wedding'
  },
  {
    id: 'promo-2',
    title: 'Neon Birthday Bash Bundles',
    subtitle: 'Complete DJ, sound, lighting & decorator starting from ₹24,999',
    badge: 'Trending',
    image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&q=80&w=800',
    gradient: 'from-amber-400/80 to-rose-500/80',
    tag: 'Birthday'
  },
  {
    id: 'promo-3',
    title: 'Premium Corporate Seminars',
    subtitle: 'Verified sound systems, drone photography & luxury catering for corporate meets',
    badge: 'Verified Deals',
    image: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80&w=800',
    gradient: 'from-blue-600/80 to-indigo-700/80',
    tag: 'Corporate'
  }
];

export const DEFAULT_VENDORS = [
  {
    id: 'v1',
    name: 'The Royal Grand Pavilion',
    category: 'Banquet Hall',
    tagline: 'Palatial luxury banquets with heritage aesthetics',
    description: 'The Royal Grand Pavilion is a premier five-star luxury event hall. Offering a grand ballroom with a seating capacity of over 1,200 guests, stunning high ceilings, and pre-integrated central climate control. Perfectly suited for grand destination weddings, lavish receptions, and high-profile corporate galas.',
    rating: 4.9,
    reviewCount: 348,
    trustScore: 99,
    distance: '1.2 km',
    responseTime: '< 10 mins',
    verified: true,
    basePrice: 150000,
    images: [
      'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=800',
      'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&q=80&w=800',
      'https://images.unsplash.com/photo-1469371670807-013ccf25f16a?auto=format&fit=crop&q=80&w=800'
    ],
    location: 'Mumbai',
    features: ['Valet Parking (200+ Cars)', 'In-house Multi-Cuisine Catering', 'Central AC', '2 Premium Bridal Suites', 'Sound Isolation & Stage Rigging'],
    services: [
      { name: 'Grand Ballroom Rental (Full Day)', price: 150000, description: 'Exclusive access to the main grand ballroom, stage, and dynamic house lighting.', unit: 'day' },
      { name: 'Lawn & Open Terrace Area Addition', price: 60000, description: 'Stunning landscaped garden space for outdoor buffet or fire ceremony.', unit: 'event' }
    ],
    reviews: [],
    bookingsCount: 1420,
    occasion: ['Wedding'],
    capacity: 1200,
    whatsapp: '919999999999'
  },
  {
    id: 'v2',
    name: 'Aura Premium Florals & Decor',
    category: 'Decorator',
    tagline: 'High-concept floral themes and bespoke glass installations',
    description: 'Specializing in contemporary, bohemian, and grand royal Indian wedding themes. Our in-house team of structural designers and master florists bring complex mood boards to life. We utilize imported orchids, premium drapery, and custom kinetic light fixtures to create an unforgettable fairy tale landscape.',
    rating: 4.8,
    reviewCount: 215,
    trustScore: 97,
    distance: '2.5 km',
    responseTime: '< 15 mins',
    verified: true,
    basePrice: 45000,
    images: [
      'https://images.unsplash.com/photo-1522413416052-4065f8a8de35?auto=format&fit=crop&q=80&w=800',
      'https://images.unsplash.com/photo-1478147427282-58a87a120781?auto=format&fit=crop&q=80&w=800'
    ],
    location: 'Mumbai',
    founderName: 'Aditi Sharma',
    founderImage: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=200',
    features: ['Imported Fresh Flowers', 'Kinetic Light Installations', 'Interactive Photo Booths'],
    services: [
      { name: 'Traditional Marigold Mandap & Stage Decor', price: 45000, description: 'Gorgeous marigold & jasmine ceiling strings, brass accessories, and high-back traditional seating.', unit: 'event' }
    ],
    reviews: [],
    bookingsCount: 840,
    occasion: ['Wedding'],
    whatsapp: '918888888888'
  }
];
