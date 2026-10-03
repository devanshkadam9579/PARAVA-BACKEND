export const DEFAULT_CATEGORIES = [
  {
    id: 'banquet-hall',
    name: 'Venues',
    iconName: 'Building2',
    image: 'https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&q=80&w=600',
    description: 'Luxury banquet halls, lush green lawns, and heritage celebration pavilions',
    displayOrder: 1,
    status: 'active',
    services: ['AC Ballroom Rental', 'Open Lawn & Garden', 'Bridal Suite', 'Valet Parking']
  },
  {
    id: 'decorator',
    name: 'Decorators',
    iconName: 'Sparkles',
    image: 'https://images.unsplash.com/photo-1522413416052-4065f8a8de35?auto=format&fit=crop&q=80&w=600',
    description: 'Bespoke floral setups, stage lighting, mandap designs, and entrance tunnels',
    displayOrder: 2,
    status: 'active',
    services: ['Floral Mandap & Stage', 'Neon Photo Booth', 'Glasshouse Theme', 'Fairy Lights Draping']
  },
  {
    id: 'photographer',
    name: 'Photography',
    iconName: 'Camera',
    image: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&q=80&w=600',
    description: 'Cinematic 4K wedding films, candid photojournalism, and aerial drone coverage',
    displayOrder: 3,
    status: 'active',
    services: ['Full Day 4K Video & Candid', 'Drone Aerial Highlights', 'Pre-Wedding Shoot', 'Handcrafted Album']
  },
  {
    id: 'dj',
    name: 'DJ & Sound',
    iconName: 'Music',
    image: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&q=80&w=600',
    description: 'Concert-grade sound systems, intelligent moving head lights, and celebrity DJs',
    displayOrder: 4,
    status: 'active',
    services: ['Sangeet & Party DJ Set', 'Line Array Concert Audio', 'Cold Pyro & Fog Machines', 'LED Wall Stage Rigging']
  },
  {
    id: 'catering',
    name: 'Catering',
    iconName: 'Utensils',
    image: 'https://images.unsplash.com/photo-1555244162-803834f70033?auto=format&fit=crop&q=80&w=600',
    description: 'Curated royal multi-cuisine feasts, gourmet live chaat, and high-tea spreads',
    displayOrder: 5,
    status: 'active',
    services: ['Royal Multi-Cuisine Buffet', 'Live Gourmet Chaat Counter', 'Signature Mocktail Bar', 'Dessert & Ice Cream Parlour']
  },
  {
    id: 'makeup-artist',
    name: 'Makeup Artists',
    iconName: 'Palette',
    image: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?auto=format&fit=crop&q=80&w=600',
    description: 'Airbrush HD bridal artistry, hair styling, saree draping, and grooming',
    displayOrder: 6,
    status: 'active',
    services: ['HD Bridal Airbrush Makeover', 'Reception Glam & Hair Styling', 'Family Draping & Touch-up', 'Pre-Bridal Skincare']
  },
  {
    id: 'cake-desserts',
    name: 'Cake & Desserts',
    iconName: 'Cake',
    image: 'https://images.unsplash.com/photo-1535141192574-5d4897c13636?auto=format&fit=crop&q=80&w=600',
    description: 'Architectural tiered wedding cakes, French macarons, and dessert tables',
    displayOrder: 7,
    status: 'active',
    services: ['Multi-Tier Fondant Cake', 'Artisanal Macaron Tower', 'Live Belgian Waffle Counter', 'Bespoke Sweet Gifting Boxes']
  },
  {
    id: 'event-planner',
    name: 'Event Planners',
    iconName: 'ClipboardList',
    image: 'https://images.unsplash.com/photo-1511795409834-ef04bbd61622?auto=format&fit=crop&q=80&w=600',
    description: 'End-to-end wedding, corporate, and milestone celebration coordinators',
    displayOrder: 8,
    status: 'active',
    services: ['Complete Wedding Coordination', 'Vendor Hospitality Management', 'Budget & Timeline Planning', 'On-Day Stage Direction']
  }
];

export const DEFAULT_OPERATIONAL_CITIES = [
  'Kolhapur',
  'Pune',
  'Nagpur',
  'Nashik',
  'Mumbai',
  'Delhi NCR',
  'Bangalore',
  'Hyderabad',
  'Chennai',
  'Kolkata',
  'Jaipur',
  'Ahmedabad',
  'Lucknow',
  'Satara',
  'Sangli'
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
