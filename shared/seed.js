const id = () => crypto.randomUUID();
export const presets = {
  night: {
    name: 'Studio Night',
    accent: '#c9a7fa',
    bg: '#14131b',
    surface: '#211e2b',
    text: '#f7f1e5',
    font: 'Georgia',
    radius: 16,
  },
  celebration: {
    name: 'Warm Celebration',
    accent: '#ac492c',
    bg: '#f7efe3',
    surface: '#fffaf0',
    text: '#38291f',
    font: 'Georgia',
    radius: 20,
  },
  classic: {
    name: 'Clean Classic',
    accent: '#3959ad',
    bg: '#eef2f9',
    surface: '#ffffff',
    text: '#192c43',
    font: 'Arial',
    radius: 8,
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
    ['Which film follows three friends on a road trip through Spain?', 'Zindagi Na Milegi Dobara'],
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
    decks: [
      {
        id: id(),
        rev: 0,
        title: 'The house party edition',
        group: 'Friends',
        description:
          'A practice board to get the room buzzing. Replace the sample questions with your own.',
        archived: false,
        theme: null,
        boards: [
          {
            id: id(),
            title: 'The warm-up',
            categories: cats,
            rows: [10, 20, 30, 40, 50],
            questions: cats.flatMap((c, col) =>
              [10, 20, 30, 40, 50].map((p, row) => ({
                id: id(),
                col,
                row,
                points: p,
                prompt: qs[col][0] + (row ? ' (practice variant ' + (row + 1) + ')' : ''),
                answer: qs[col][1],
                hint: '',
                notes: 'Sample content — customize before your real party.',
                type: 'text',
                media: '',
              })),
            ),
          },
        ],
      },
    ],
    rooms: [],
  };
}
