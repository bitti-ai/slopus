export interface OptionGroup {
  subcategory: string;
  options: readonly string[];
}

export const ANIMAL_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Pets", options: ["Golden retriever", "German shepherd", "Border collie", "Siberian husky", "Tabby cat", "Siamese cat", "Maine coon cat", "Rabbit", "Guinea pig", "Hamster"] },
  { subcategory: "Farm animals", options: ["Horse", "Pony", "Donkey", "Cow", "Sheep", "Goat", "Pig", "Alpaca", "Llama", "Chicken"] },
  { subcategory: "Wild mammals", options: ["Lion", "Bengal tiger", "African elephant", "Giraffe", "Zebra", "Gorilla", "Chimpanzee", "Giant panda", "Kangaroo", "Hippopotamus"] },
  { subcategory: "Forest & Arctic", options: ["Red fox", "Gray wolf", "Brown bear", "Polar bear", "Arctic fox", "Moose", "Reindeer", "Red deer", "Red squirrel", "Hedgehog"] },
  { subcategory: "Birds", options: ["Bald eagle", "Barn owl", "Peregrine falcon", "Scarlet macaw", "Peacock", "Flamingo", "Toucan", "Hummingbird", "Emperor penguin", "Mute swan"] },
  { subcategory: "Reptiles & amphibians", options: ["Green iguana", "Chameleon", "Gecko", "Bearded dragon", "King cobra", "Ball python", "Nile crocodile", "Giant tortoise", "Red-eyed tree frog", "Axolotl"] },
  { subcategory: "Marine life", options: ["Bottlenose dolphin", "Humpback whale", "Orca", "Harbor seal", "Sea otter", "Green sea turtle", "Great white shark", "Manta ray", "Clownfish", "Seahorse"] },
  { subcategory: "Invertebrates", options: ["Monarch butterfly", "Honeybee", "Ladybug", "Dragonfly", "Praying mantis", "Tarantula", "Octopus", "Moon jellyfish", "Hermit crab", "Starfish"] },
];

export const PRODUCT_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Technology", options: ["Smartphone", "Laptop", "Tablet", "Smartwatch", "Wireless earbuds", "Camera", "Gaming console", "Desktop computer", "Smart speaker", "VR headset"] },
  { subcategory: "Fashion", options: ["Wristwatch", "Sneaker", "Handbag", "Sunglasses", "Jacket", "Dress", "Backpack", "Boot", "Wallet", "Headphones"] },
  { subcategory: "Beauty", options: ["Perfume bottle", "Skincare bottle", "Lipstick", "Compact mirror", "Serum dropper", "Candle", "Soap bar", "Makeup palette", "Hair dryer", "Electric shaver"] },
  { subcategory: "Vehicles", options: ["Sports car", "Electric sedan", "Motorcycle", "City bicycle", "SUV", "Pickup truck", "Scooter", "Sailboat", "Camper van", "Concept car"] },
  { subcategory: "Home", options: ["Lounge chair", "Table lamp", "Sofa", "Dining table", "Desk chair", "Floor lamp", "Bookshelf", "Side table", "Wall clock", "Ceramic vase"] },
  { subcategory: "Food & drink", options: ["Coffee bag", "Tea tin", "Chocolate box", "Wine bottle", "Soda can", "Olive oil bottle", "Juice carton", "Spice jar", "Bakery box", "Water bottle"] },
  { subcategory: "Sports", options: ["Running shoe", "Football", "Tennis racket", "Bicycle helmet", "Yoga mat", "Skateboard", "Golf club", "Basketball", "Ski goggles", "Fitness tracker"] },
  { subcategory: "Tools", options: ["Power drill", "Toolbox", "Kitchen knife", "Flashlight", "Tape measure", "Multitool", "Paint brush", "Garden shears", "Wrench", "Work gloves"] },
  { subcategory: "Toys", options: ["Robot toy", "Model car", "Building blocks", "Plush animal", "Board game", "Wooden train", "Action figure", "Puzzle box", "Toy camera", "Kite"] },
  { subcategory: "Packaging", options: ["Shipping box", "Gift box", "Paper pouch", "Glass jar", "Metal tin", "Pump bottle", "Cardboard tube", "Takeaway cup", "Resealable bag", "Display carton"] },
];

export const CLOTHING_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Tops", options: ["T-shirt", "Polo shirt", "Button-up shirt", "Blouse", "Tank top", "Crop top", "Sweater", "Cardigan", "Hoodie", "Sweatshirt", "Turtleneck", "Vest"] },
  { subcategory: "Bottoms", options: ["Jeans", "Trousers", "Chinos", "Cargo pants", "Shorts", "Skirt", "Pleated skirt", "Leggings", "Joggers"] },
  { subcategory: "Dresses & one-pieces", options: ["Casual dress", "Sundress", "Maxi dress", "Cocktail dress", "Evening gown", "Wedding dress", "Jumpsuit", "Romper", "Overalls"] },
  { subcategory: "Outerwear", options: ["Jacket", "Bomber jacket", "Biker jacket", "Blazer", "Trench coat", "Overcoat", "Parka", "Puffer jacket", "Raincoat", "Windbreaker", "Poncho"] },
  { subcategory: "Suits & uniforms", options: ["Two-piece suit", "Three-piece suit", "Tuxedo", "School uniform", "Military uniform", "Police uniform", "Medical scrubs", "Chef's uniform", "Work coveralls"] },
  { subcategory: "Activewear & swimwear", options: ["Tracksuit", "Sports jersey", "Sports bra", "Running shorts", "Yoga pants", "Leotard", "One-piece swimsuit", "Bikini", "Swimming trunks", "Wetsuit"] },
  { subcategory: "Underwear & sleepwear", options: ["Pajamas", "Nightgown", "Bathrobe", "Undershirt", "Bra", "Briefs", "Boxer shorts", "Socks", "Tights"] },
  { subcategory: "Footwear", options: ["Sneakers", "Running shoes", "Dress shoes", "Loafers", "Ankle boots", "Knee-high boots", "Hiking boots", "Sandals", "High heels", "Ballet flats", "Slippers", "Flip-flops"] },
];

export const ACCESSORY_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Eyewear", options: ["Glasses", "Reading glasses", "Round glasses", "Sunglasses", "Aviator sunglasses", "Cat-eye sunglasses", "Sports sunglasses", "Goggles"] },
  { subcategory: "Jewelry", options: ["Necklace", "Pendant necklace", "Choker", "Chain necklace", "Stud earrings", "Hoop earrings", "Drop earrings", "Ring", "Wedding ring", "Bracelet", "Bangle", "Anklet", "Brooch", "Cufflinks", "Wristwatch"] },
  { subcategory: "Headwear", options: ["Baseball cap", "Beanie", "Fedora", "Bucket hat", "Beret", "Sun hat", "Cowboy hat", "Visor", "Headscarf", "Hijab", "Turban"] },
  { subcategory: "Bags", options: ["Handbag", "Shoulder bag", "Crossbody bag", "Tote bag", "Backpack", "Clutch bag", "Waist bag", "Messenger bag", "Briefcase", "Wallet"] },
  { subcategory: "Belts & neckwear", options: ["Belt", "Suspenders", "Necktie", "Bow tie", "Scarf", "Bandana", "Shawl", "Pocket square"] },
  { subcategory: "Hair accessories", options: ["Headband", "Hair clip", "Barrette", "Scrunchie", "Hair tie", "Hair ribbon", "Hairpin", "Tiara"] },
  { subcategory: "Other accessories", options: ["Gloves", "Mittens", "Earmuffs", "Headphones", "Earbuds", "Umbrella", "Walking cane", "Pocket watch"] },
];

export interface ClothingSettingGroup {
  id: "color" | "fabric";
  label: string;
  options: ReadonlyArray<{ id: string; label: string; prompt: string }>;
}

export const CLOTHING_SETTING_GROUPS: readonly ClothingSettingGroup[] = [
  { id: "color", label: "Color", options: [
    ["black", "Black"], ["white", "White"], ["gray", "Gray"], ["charcoal", "Charcoal"],
    ["cream", "Cream"], ["beige", "Beige"], ["tan", "Tan"], ["brown", "Brown"],
    ["red", "Red"], ["burgundy", "Burgundy"], ["orange", "Orange"], ["yellow", "Yellow"],
    ["mustard", "Mustard"], ["green", "Green"], ["olive", "Olive"], ["teal", "Teal"],
    ["blue", "Blue"], ["navy-blue", "Navy blue"], ["light-blue", "Light blue"],
    ["purple", "Purple"], ["lavender", "Lavender"], ["pink", "Pink"], ["gold", "Gold"], ["silver", "Silver"],
  ].map(([id, label]) => ({ id, label, prompt: `in ${label.toLowerCase()}` })) },
  { id: "fabric", label: "Fabric", options: [
    ["cotton", "Cotton"], ["linen", "Linen"], ["denim", "Denim"], ["wool", "Wool"],
    ["cashmere", "Cashmere"], ["silk", "Silk"], ["satin", "Satin"], ["velvet", "Velvet"],
    ["corduroy", "Corduroy"], ["tweed", "Tweed"], ["fleece", "Fleece"], ["jersey", "Jersey"],
    ["chiffon", "Chiffon"], ["lace", "Lace"], ["tulle", "Tulle"], ["canvas", "Canvas"],
    ["polyester", "Polyester"], ["nylon", "Nylon"], ["spandex", "Spandex"],
    ["leather", "Leather"], ["faux-leather", "Faux leather"], ["suede", "Suede"],
  ].map(([id, label]) => ({ id, label, prompt: `made of ${label.toLowerCase()}` })) },
];

export const LOCATION_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Urban", options: ["City alley", "Downtown avenue", "Rooftop", "Subway platform", "Street market", "City square", "Parking garage", "Pedestrian bridge", "Apartment street", "Train station"] },
  { subcategory: "Interiors", options: ["Hotel lobby", "Modern kitchen", "Artist studio", "Library", "Corner café", "Penthouse", "Warehouse loft", "Recording studio", "Museum gallery", "Home office"] },
  { subcategory: "Nature", options: ["Pine forest", "Desert canyon", "Alpine lake", "Wildflower meadow", "Waterfall", "Volcanic field", "Bamboo grove", "Glacier valley", "Marsh", "Redwood forest"] },
  { subcategory: "Historic", options: ["Medieval market", "Victorian manor", "Roman courtyard", "Ancient temple", "Castle hall", "Old observatory", "Monastery", "Colonial street", "Art Deco ballroom", "Renaissance workshop"] },
  { subcategory: "Sci-fi", options: ["Lunar base", "Orbital station", "Mars habitat", "Starship bridge", "Cyberpunk alley", "Alien greenhouse", "Robot factory", "Spaceport", "Cryogenic bay", "Underwater laboratory"] },
  { subcategory: "Fantasy", options: ["Enchanted forest", "Wizard library", "Dragon cave", "Floating city", "Elven palace", "Ancient ruins", "Crystal cavern", "Mountain fortress", "Hidden village", "Royal throne room"] },
  { subcategory: "Coastal", options: ["Tropical beach", "Rocky cove", "Fishing harbor", "Lighthouse cliff", "Boardwalk", "Coral lagoon", "Sea cave", "Marina", "Coastal village", "Pier"] },
  { subcategory: "Rural", options: ["Farmhouse", "Country road", "Vineyard", "Orchard", "Windmill field", "Mountain village", "Rice terrace", "Ranch", "Lavender farm", "Remote cabin"] },
  { subcategory: "Industrial", options: ["Steel mill", "Shipyard", "Power station", "Factory floor", "Cargo terminal", "Oil refinery", "Aircraft hangar", "Mining tunnel", "Data center", "Construction site"] },
  { subcategory: "Public spaces", options: ["Airport terminal", "Concert hall", "University campus", "Sports arena", "Hospital corridor", "Shopping arcade", "Courthouse", "Community pool", "Convention center", "Botanical garden"] },
];

export interface LocationSettingGroup {
  id: "time" | "weather" | "season";
  label: string;
  options: ReadonlyArray<{ id: string; label: string; prompt: string }>;
}

/** Optional, independent qualifiers. Keeping them outside the location names
 * lets one place be reused as, for example, "Coastal village, at night, in
 * winter" instead of filling the catalog with five near-duplicates. */
export const LOCATION_SETTING_GROUPS: readonly LocationSettingGroup[] = [
  { id: "time", label: "Time of day", options: [
    { id: "dawn", label: "Dawn", prompt: "at dawn" },
    { id: "morning", label: "Morning", prompt: "in the morning" },
    { id: "midday", label: "Midday", prompt: "at midday" },
    { id: "golden-hour", label: "Golden hour", prompt: "at golden hour" },
    { id: "dusk", label: "Dusk", prompt: "at dusk" },
    { id: "night", label: "Night", prompt: "at night" },
  ] },
  { id: "weather", label: "Weather", options: [
    { id: "clear", label: "Clear", prompt: "in clear weather" },
    { id: "overcast", label: "Overcast", prompt: "under overcast skies" },
    { id: "rain", label: "Rain", prompt: "in rain" },
    { id: "fog", label: "Fog", prompt: "in fog" },
    { id: "snow", label: "Snow", prompt: "in snow" },
    { id: "storm", label: "Storm", prompt: "during a storm" },
  ] },
  { id: "season", label: "Season", options: [
    { id: "spring", label: "Spring", prompt: "in spring" },
    { id: "summer", label: "Summer", prompt: "in summer" },
    { id: "autumn", label: "Autumn", prompt: "in autumn" },
    { id: "winter", label: "Winter", prompt: "in winter" },
  ] },
];

export const STYLE_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Cinematic", options: ["Film noir", "35 mm documentary", "Epic cinema", "Indie drama", "Neo-noir", "Romantic cinema", "Action thriller", "Period drama", "Science-fiction cinema", "Naturalist cinema"] },
  { subcategory: "Photography", options: ["Editorial photography", "Street photography", "Studio portrait", "Macro photography", "Architectural photography", "Fashion photography", "Food photography", "Wildlife photography", "Travel photography", "Product photography"] },
  { subcategory: "Illustration", options: ["Storybook watercolor", "Ink drawing", "Colored pencil", "Gouache illustration", "Paper collage", "Comic illustration", "Botanical illustration", "Technical drawing", "Children's illustration", "Editorial illustration"] },
  { subcategory: "Animation", options: ["Cinematic anime", "Clay animation", "Stop motion", "Cel animation", "Cut-paper animation", "3D character animation", "Motion graphics", "Pixel animation", "Puppet animation", "Rotoscope animation"] },
  { subcategory: "Fine art", options: ["Oil painting", "Impressionism", "Expressionism", "Surrealism", "Charcoal drawing", "Pastel painting", "Fresco", "Woodcut print", "Screen print", "Sculptural relief"] },
  { subcategory: "Graphic", options: ["Swiss design", "Bauhaus poster", "Pop art", "Minimal poster", "Brutalist design", "Art Deco graphic", "Memphis design", "Risograph print", "Editorial layout", "Geometric abstraction"] },
  { subcategory: "Retro", options: ["1970s retrofuturism", "1980s neon", "1990s music video", "Silent film", "Technicolor musical", "Mid-century advertising", "VHS home video", "Vintage travel poster", "Y2K digital", "Analog television"] },
  { subcategory: "Experimental", options: ["Double exposure", "Datamosh", "Prism distortion", "Infrared image", "Long exposure", "Mixed media", "Photogram", "Glitch art", "Kaleidoscope", "Projection mapping"] },
  { subcategory: "Commercial", options: ["Luxury editorial", "Clean product ad", "Lifestyle campaign", "Beauty campaign", "Automotive campaign", "Sports campaign", "Food commercial", "Technology launch", "Travel campaign", "Fashion lookbook"] },
  { subcategory: "Digital", options: ["Photoreal 3D", "Low-poly 3D", "Voxel art", "Isometric render", "Holographic render", "Unreal environment", "Procedural texture", "Digital matte painting", "Vector art", "UI motion design"] },
];
