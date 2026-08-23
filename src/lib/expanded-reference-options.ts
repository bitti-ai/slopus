export interface OptionGroup {
  subcategory: string;
  options: readonly string[];
}

export interface OptionVariant {
  name: string;
  prompt: string;
}

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

export const PRODUCT_VARIANTS: readonly OptionVariant[] = [
  { name: "Minimal", prompt: "minimal, clean" },
  { name: "Premium", prompt: "premium, refined" },
  { name: "Rugged", prompt: "rugged, durable" },
  { name: "Retro", prompt: "retro-inspired" },
  { name: "Eco", prompt: "sustainable, natural" },
];

export const LOCATION_GROUPS: readonly OptionGroup[] = [
  { subcategory: "Urban", options: ["City alley", "Downtown avenue", "Rooftop", "Subway platform", "Night market", "City square", "Parking garage", "Pedestrian bridge", "Apartment street", "Train station"] },
  { subcategory: "Interiors", options: ["Hotel lobby", "Modern kitchen", "Artist studio", "Library", "Corner café", "Penthouse", "Warehouse loft", "Recording studio", "Museum gallery", "Home office"] },
  { subcategory: "Nature", options: ["Pine forest", "Desert canyon", "Alpine lake", "Wildflower meadow", "Waterfall", "Volcanic field", "Bamboo grove", "Glacier valley", "Misty marsh", "Redwood forest"] },
  { subcategory: "Historic", options: ["Medieval market", "Victorian manor", "Roman courtyard", "Ancient temple", "Castle hall", "Old observatory", "Monastery", "Colonial street", "Art Deco ballroom", "Renaissance workshop"] },
  { subcategory: "Sci-fi", options: ["Lunar base", "Orbital station", "Mars habitat", "Starship bridge", "Cyberpunk alley", "Alien greenhouse", "Robot factory", "Spaceport", "Cryogenic bay", "Underwater laboratory"] },
  { subcategory: "Fantasy", options: ["Enchanted forest", "Wizard library", "Dragon cave", "Floating city", "Elven palace", "Ancient ruins", "Crystal cavern", "Mountain fortress", "Hidden village", "Royal throne room"] },
  { subcategory: "Coastal", options: ["Tropical beach", "Rocky cove", "Fishing harbor", "Lighthouse cliff", "Boardwalk", "Coral lagoon", "Sea cave", "Marina", "Coastal village", "Storm pier"] },
  { subcategory: "Rural", options: ["Farmhouse", "Country road", "Vineyard", "Orchard", "Windmill field", "Mountain village", "Rice terrace", "Ranch", "Lavender farm", "Remote cabin"] },
  { subcategory: "Industrial", options: ["Steel mill", "Shipyard", "Power station", "Factory floor", "Cargo terminal", "Oil refinery", "Aircraft hangar", "Mining tunnel", "Data center", "Construction site"] },
  { subcategory: "Public spaces", options: ["Airport terminal", "Concert hall", "University campus", "Sports arena", "Hospital corridor", "Shopping arcade", "Courthouse", "Community pool", "Convention center", "Botanical garden"] },
];

export const LOCATION_VARIANTS: readonly OptionVariant[] = [
  { name: "At dawn", prompt: "at dawn" },
  { name: "At night", prompt: "at night" },
  { name: "In rain", prompt: "in light rain" },
  { name: "In winter", prompt: "in winter" },
  { name: "Golden hour", prompt: "at golden hour" },
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

export const STYLE_VARIANTS: readonly OptionVariant[] = [
  { name: "Moody", prompt: "moody" },
  { name: "Bright", prompt: "bright" },
  { name: "Minimal", prompt: "minimal" },
  { name: "Textured", prompt: "textured" },
  { name: "High contrast", prompt: "high-contrast" },
];
