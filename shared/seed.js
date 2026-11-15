const id = () => crypto.randomUUID();
export const presets = {
  night: {
    name: 'Midnight Quiz',
    icon: '🌙',
    accent: '#c9a7fa',
    bg: '#14131b',
    surface: '#211e2b',
    text: '#f7f1e5',
    font: 'system-ui',
    radius: 16,
  },
  classic: {
    name: 'Classic Light',
    icon: '☀️',
    accent: '#3959ad',
    bg: '#eef2f9',
    surface: '#ffffff',
    text: '#192c43',
    font: 'system-ui',
    radius: 8,
  },
  diwali: {
    name: 'Diwali Lights',
    icon: '🪔',
    accent: '#e7c56d',
    bg: '#5f567b',
    surface: '#403353',
    text: '#fff2cf',
    font: 'system-ui',
    radius: 14,
  },
  christmas: {
    name: 'Christmas Cheer',
    icon: '🎄',
    accent: '#f4c86d',
    bg: '#153b32',
    surface: '#235044',
    text: '#fff9ec',
    font: 'system-ui',
    radius: 16,
  },
  india: {
    name: 'India Tricolor',
    icon: '🇮🇳',
    accent: '#0b6f38',
    bg: '#fff9ed',
    surface: '#ffffff',
    text: '#183026',
    font: 'system-ui',
    radius: 12,
  },
};
export function seed() {
  const cats = [
    'Movie magic',
    'Around the world',
    'Food for thought',
    'Nature calls',
    'Just for fun',
  ];
  const qs = [
    ['Which 1993 film brought dinosaurs back to life on an island?', 'Jurassic Park'],
    ['In which country is Petra?', 'Jordan'],
    ['Which spice gives saffron rice its golden colour?', 'Saffron'],
    ['What is the fastest land animal?', 'Cheetah'],
    ['How many sides does a hexagon have?', 'Six'],
  ];
  return {
    rev: 0,
    brand: {
      ...presets.night,
      title: 'The Quiz Room',
      tagline: 'Your questions. Your people.',
      logo: '',
      background: '',
      overlay: 75,
    },
    cohost: '',
    activeRoomId: '',
    activeRoomExpires: 0,
    decks: [
      {
        id: id(),
        rev: 0,
        title: 'The house party edition',
        group: 'Friends',
        description: 'Five practice questions. Create a new deck for your own party.',
        archived: false,
        theme: null,
        boards: [
          {
            id: id(),
            title: 'The warm-up',
            categories: cats,
            rows: [10],
            questions: cats.flatMap((c, col) =>
              [10].map((p, row) => ({
                id: id(),
                col,
                row,
                points: p,
                prompt: qs[col][0],
                answer: qs[col][1],
                hint: '',
                notes: 'Sample content — customize before your real party.',
                type: 'text',
                media: '',
                answerType: 'text',
                answerMedia: '',
              })),
            ),
          },
        ],
      },
    ],
    rooms: [],
  };
}
