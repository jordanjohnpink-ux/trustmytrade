'use strict';
// Idempotent category taxonomy seeder.
// Run with: node scripts/seed-categories.js
// Matches existing rows by slug — safe to re-run any number of times.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PUBLIC_CATEGORIES = [
    'Builders','Roofers','Plumbers','Electricians','Gas Engineers','Heating Engineers','Boiler Engineers',
    'Bathroom Fitters','Kitchen Fitters','Carpenters','Joiners','Painters & Decorators','Plasterers','Renderers',
    'Tilers','Flooring Specialists','Carpet Fitters','Wood Flooring Specialists','Vinyl Flooring Specialists',
    'Driveway Installers','Patio Installers','Paving Contractors','Landscapers','Gardeners','Tree Surgeons',
    'Fencing Contractors','Decking Installers','Artificial Grass Installers','Groundworkers','Bricklayers',
    'Stonemasons','Concrete Contractors','Demolition Contractors','Scaffolders','Steel Fabricators','Welders',
    'Structural Engineers','Architects','Architectural Designers','Planning Consultants','Building Surveyors',
    'Party Wall Surveyors','Project Managers','House Extension Specialists','Loft Conversion Specialists',
    'Garage Conversion Specialists','Basement Conversion Specialists','Renovation Contractors',
    'Refurbishment Contractors','New Build Contractors','Property Maintenance Companies','Handymen',
    'Landlord Maintenance Services','Commercial Maintenance Contractors','Facilities Management Companies',
    'Fire & Security Companies','Fire Alarm Installers','Fire Alarm Engineers','Fire Risk Assessors',
    'Fire Safety Consultants','Fire Door Installers','Fire Door Inspectors','Fire Stopping Contractors',
    'Passive Fire Protection Contractors','Fire Extinguisher Companies','Fire Extinguisher Servicing Companies',
    'Sprinkler Installers','Sprinkler Maintenance Companies','Fire Suppression Companies','Dry Riser Specialists',
    'Wet Riser Specialists','Emergency Lighting Installers','Smoke Alarm Installers',
    'Carbon Monoxide Alarm Installers','AOV Specialists','Smoke Ventilation Specialists','Fire Damper Specialists',
    'Security System Installers','CCTV Installers','CCTV Maintenance Companies','Intruder Alarm Installers',
    'Burglar Alarm Installers','Alarm Engineers','Access Control Installers','Access Control Engineers',
    'Door Entry System Installers','Intercom Installers','Video Intercom Installers','Smart Lock Installers',
    'Digital Lock Installers','Locksmiths','Emergency Locksmiths','Safe Engineers','Security Door Installers',
    'Roller Shutter Installers','Security Shutter Companies','Automatic Gate Installers','Electric Gate Engineers',
    'Gate Automation Specialists','Barrier Installers','Bollard Installers','Vehicle Access Control Companies',
    'ANPR System Installers','Perimeter Security Contractors','Security Lighting Installers',
    'Smart Home Security Installers','Doorbell Camera Installers','Boarding Up Companies',
    'Emergency Boarding Up Services','Commercial Security Companies','Residential Security Companies',
    'Window Fitters','Double Glazing Installers','Glaziers','Emergency Glaziers','Door Fitters',
    'Garage Door Installers','Shopfront Installers','Conservatory Installers','Guttering Companies',
];

const HIDDEN_CATEGORIES = [
    'Quantity Surveyors','Building Control Consultants','Property Developers','General Contractors',
    'Odd Job Services','Resin Flooring Specialists','Screeders','Laminate Flooring Installers',
    'Suspended Ceiling Installers','Partitioning Contractors','Shopfitters','Office Fit Out Companies',
    'Restaurant Fit Out Contractors','Bar Fit Out Contractors','Hotel Refurbishment Contractors',
    'School Contractors','Care Home Contractors','Healthcare Contractors','Warehouse Contractors',
    'Factory Maintenance Contractors','Industrial Contractors','Commercial Builders','Commercial Electricians',
    'Commercial Plumbers','Commercial Gas Engineers','Commercial Roofing Contractors',
    'Commercial Glazing Companies','Commercial Flooring Contractors','Commercial Decorators',
    'Office Cleaning Companies','Domestic Cleaners','Commercial Cleaners','Deep Cleaning Companies',
    'End Of Tenancy Cleaners','Carpet Cleaners','Upholstery Cleaners','Oven Cleaners','Window Cleaners',
    'Builders Clean Companies','Holiday Let Cleaners','Airbnb Cleaners','Biohazard Cleaning Companies',
    'Trauma Cleaning Companies','Hoarder Cleaning Companies','Mould Removal Companies',
    'Waste Removal Companies','Rubbish Clearance Companies','House Clearance Companies',
    'Garden Clearance Companies','Garage Clearance Companies','Loft Clearance Companies',
    'Office Clearance Companies','Skip Hire Companies','Grab Hire Companies','Licensed Waste Carriers',
    'Recycling Companies','Pest Control Companies','Rat Control Specialists','Mouse Control Specialists',
    'Wasp Nest Removal Companies','Bed Bug Specialists','Bird Control Companies','Pigeon Proofing Companies',
    'Mole Control Specialists','Insect Control Specialists','Woodworm Treatment Companies',
    'Asbestos Surveyors','Asbestos Removal Companies','Asbestos Testing Companies',
    'Asbestos Garage Roof Removal Companies','Lead Paint Removal Companies','Radon Testing Companies',
    'Japanese Knotweed Specialists','Invasive Weed Specialists','Environmental Consultants',
    'Removal Companies','Man And Van Services','House Removal Companies','Office Removal Companies',
    'Furniture Removal Companies','Piano Removal Specialists','Packing Services','Storage Companies',
    'Courier Services','Delivery Services','Student Removal Companies','Heavy Item Movers',
    'Machinery Movers','Agricultural Contractors','Farm Contractors','Equestrian Contractors',
    'Stable Builders','Barn Conversion Specialists','Field Drainage Contractors',
    'Agricultural Fencing Contractors','Paddock Fencing Contractors','Menage Installers',
    'Sports Surface Contractors','Playground Installers','Playground Safety Surface Installers',
    'Tennis Court Installers','Outdoor Gym Installers','Garden Room Installers','Log Cabin Installers',
    'Shed Installers','Summerhouse Installers','Pergola Installers','Outdoor Kitchen Installers',
    'Pond Maintenance Companies','Lake Maintenance Companies','Smart Home Installers',
    'Home Automation Companies','Home Cinema Installers','AV Installers','TV Wall Mounting Services',
    'Aerial Installers','Satellite Dish Installers','Starlink Installers','Data Cabling Companies',
    'Network Cabling Installers','Wi-Fi Installers','Telecoms Engineers','Fibre Installers',
    'IT Support Companies','Computer Repair Companies','Printer Setup Services',
    'Electrical Testing Companies','EICR Electricians','PAT Testing Companies',
    'Gas Safety Certificate Engineers','Landlord Certificate Providers','HMO Compliance Specialists',
    'Legionella Risk Assessors','Water Hygiene Companies','Lift Inspection Companies',
    'Fire Door Compliance Companies','Emergency Lighting Testing Companies','Dry Riser Testing Companies',
    'Sprinkler Testing Companies','Asbestos Compliance Companies','EPC Certificate Providers',
    'Building Compliance Consultants','Health And Safety Consultants','Lift Installers',
    'Lift Maintenance Companies','Platform Lift Installers','Stairlift Installers',
    'Stairlift Repair Companies','Home Lift Installers','Disabled Access Contractors',
    'Mobility Bathroom Installers','Wet Room Installers','Ramp Installers','Handrail Installers',
    'Accessible Kitchen Installers','Care Home Adaptation Contractors','Emergency Plumbers',
    'Emergency Electricians','Emergency Roofers','Emergency Drainage Companies',
    'Emergency Boiler Engineers','Emergency Gas Engineers','Emergency Heating Engineers',
    'Emergency Pest Control','Emergency Tree Surgeons','Emergency Leak Detection',
    'Emergency Property Repair','Emergency Fire Alarm Engineers','Emergency Security Engineers',
    'Emergency Gate Repair Companies','Emergency Shutter Repair Companies',
    'Emergency Flood Response Companies','Emergency Cleaning Companies','Window Cleaning Companies',
    'Roof Cleaning Companies','Solar Panel Cleaning Companies','Exterior Cleaning Companies',
    'Pressure Washing Companies','Moss Removal Companies','Facade Restoration Companies',
    'Cladding Contractors','External Wall Insulation Companies','Insulation Contractors',
    'Loft Insulation Installers','Cavity Wall Insulation Installers','Damp Proofing Companies',
    'Waterproofing Contractors','Basement Waterproofing Companies','Chimney Specialists',
    'Chimney Sweeps','Chimney Repair Companies','Fascia & Soffit Installers','Roof Window Installers',
    'Velux Window Installers','Shutter Installers','Blind Fitters','Curtain Fitters',
    'Interior Designers','Kitchen Designers','Bathroom Designers','Bedroom Fitters',
    'Fitted Wardrobe Companies','Media Wall Installers','Bespoke Furniture Makers','Cabinet Makers',
    'Furniture Restorers','Upholsterers','French Polishers','Staircase Specialists',
    'Balustrade Installers','Glass Balustrade Specialists','Metal Balustrade Specialists',
    'Microcement Specialists','Polished Concrete Specialists','Venetian Plaster Specialists',
    'Spray Painting Specialists','Kitchen Spraying Companies','uPVC Spraying Companies',
    'Wallpapering Specialists','Mural Artists','Home Staging Companies','Soft Furnishing Companies',
    'Central Heating Engineers','Oil Heating Engineers','LPG Heating Engineers',
    'Underfloor Heating Installers','Radiator Installers','Power Flushing Companies',
    'Smart Thermostat Installers','Heat Pump Installers','Air Source Heat Pump Installers',
    'Ground Source Heat Pump Installers','Solar Panel Installers','Solar Battery Installers',
    'Solar Thermal Installers','EV Charger Installers','Renewable Energy Installers',
    'Energy Efficiency Specialists','Home Energy Assessors','EPC Assessors','Retrofit Assessors',
    'Biomass Boiler Installers','Ventilation Specialists','Air Conditioning Installers',
    'Air Conditioning Engineers','MVHR Installers','Extractor Fan Installers',
    'Leak Detection Companies','Drainage Companies','Drain Unblocking Companies',
    'CCTV Drain Survey Companies','Drain Repair Companies','Drain Relining Companies',
    'Sewer Contractors','Septic Tank Companies','Sewage Treatment Plant Installers',
    'Pump Station Specialists','Water Main Installers','Water Softener Installers',
    'Rainwater Harvesting Companies','Flood Prevention Companies','Irrigation System Installers',
    'Pond Installers','Swimming Pool Contractors','Hot Tub Installers','Spa Maintenance Companies',
];

const RESTRICTED_CATEGORIES = [
    'Gas Engineers','Gas Safe Engineers','Boiler Engineers','Oil Heating Engineers','LPG Heating Engineers',
    'Electricians','Commercial Electricians','EICR Electricians','Electrical Testing Companies',
    'EV Charger Installers','Fire Alarm Installers','Fire Alarm Engineers','Fire Risk Assessors',
    'Fire Safety Consultants','Fire Door Installers','Fire Door Inspectors','Fire Stopping Contractors',
    'Passive Fire Protection Contractors','Sprinkler Installers','Fire Suppression Companies',
    'Dry Riser Specialists','Wet Riser Specialists','Emergency Lighting Installers',
    'Smoke Ventilation Specialists','AOV Specialists','Fire Damper Specialists','Security System Installers',
    'CCTV Installers','Access Control Installers','Door Entry System Installers','Automatic Gate Installers',
    'Barrier Installers','Bollard Installers','Asbestos Surveyors','Asbestos Removal Companies',
    'Asbestos Testing Companies','Waste Removal Companies','Licensed Waste Carriers','Pest Control Companies',
    'Tree Surgeons','Scaffolders','Demolition Contractors','Structural Engineers','Architects',
    'Building Surveyors','Party Wall Surveyors','EPC Assessors','Legionella Risk Assessors',
    'Water Hygiene Companies','Lift Installers','Lift Maintenance Companies','Stairlift Installers',
    'Heat Pump Installers','Solar Panel Installers','Commercial Gas Engineers','HMO Compliance Specialists',
];

function slugify(name) {
    return String(name).toLowerCase().trim()
        .replace(/&/g, ' ')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
function seoDefaults(name) {
    return {
        seo_title: `${name} Near You | Trusted Local Trades`,
        seo_description: `Find trusted ${name} near you. Compare verified local trades, read reviews, and request quotes from approved professionals.`,
    };
}

function main() {
    const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', 'monasite.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS categories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0
    )`);
    // Same additive migrations as server.js, so this script also works against a fresh/empty db
    const cols = [
        ['slug', 'TEXT'], ['is_public', "INTEGER NOT NULL DEFAULT 1"], ['status', "TEXT NOT NULL DEFAULT 'active'"],
        ['is_restricted', 'INTEGER NOT NULL DEFAULT 0'], ['requires_documents', 'INTEGER NOT NULL DEFAULT 0'],
        ['requires_insurance', 'INTEGER NOT NULL DEFAULT 0'], ['requires_qualifications', 'INTEGER NOT NULL DEFAULT 0'],
        ['requires_manual_approval', 'INTEGER NOT NULL DEFAULT 0'], ['seo_title', "TEXT DEFAULT ''"],
        ['seo_description', "TEXT DEFAULT ''"], ['description', "TEXT DEFAULT ''"],
        ['updated_at', 'TEXT'], // SQLite forbids a non-constant default in ADD COLUMN once rows exist
    ];
    for (const [c, type] of cols) { try { db.exec(`ALTER TABLE categories ADD COLUMN ${c} ${type}`); } catch {} }

    const restrictedSet = new Set(RESTRICTED_CATEGORIES);
    const entries = [
        ...PUBLIC_CATEGORIES.map(name => ({ name, is_public: 1 })),
        ...HIDDEN_CATEGORIES.map(name => ({ name, is_public: 0 })),
    ];

    let created = 0, updated = 0;
    const maxOrderRow = db.prepare('SELECT MAX(sort_order) AS m FROM categories').get();
    let nextOrder = (maxOrderRow.m ?? -1) + 1;

    const findBySlug = db.prepare('SELECT * FROM categories WHERE slug=?');
    const findByName = db.prepare('SELECT * FROM categories WHERE name=?');
    const insert = db.prepare(`INSERT INTO categories
        (name, slug, sort_order, is_public, status, is_restricted, seo_title, seo_description, description, updated_at)
        VALUES (?,?,?,?,'active',?,?,?,?,datetime('now'))`);
    const update = db.prepare(`UPDATE categories SET name=?, is_public=?, is_restricted=?,
        seo_title=CASE WHEN seo_title='' OR seo_title IS NULL THEN ? ELSE seo_title END,
        seo_description=CASE WHEN seo_description='' OR seo_description IS NULL THEN ? ELSE seo_description END,
        updated_at=datetime('now') WHERE id=?`);

    for (const { name, is_public } of entries) {
        const slug = slugify(name);
        const isRestricted = restrictedSet.has(name) ? 1 : 0;
        const defaults = seoDefaults(name);
        // Match by slug first (the stable idempotency key); fall back to matching by exact
        // name for rows that predate the slug column.
        const existing = findBySlug.get(slug) || findByName.get(name);
        if (existing) {
            update.run(name, is_public, isRestricted, defaults.seo_title, defaults.seo_description, existing.id);
            if (!existing.slug) db.prepare('UPDATE categories SET slug=? WHERE id=?').run(slug, existing.id);
            updated++;
        } else {
            insert.run(name, slug, nextOrder++, is_public, isRestricted, defaults.seo_title, defaults.seo_description, '');
            created++;
        }
    }

    // Anything in the restricted list that didn't match a seeded category by exact name
    const allNames = new Set(entries.map(e => e.name));
    const unmatched = RESTRICTED_CATEGORIES.filter(n => !allNames.has(n));

    console.log(`Category seed complete: ${created} created, ${updated} updated.`);
    if (unmatched.length) {
        console.log(`Note: ${unmatched.length} restricted name(s) had no exact match in the public/hidden lists and were skipped: ${unmatched.join(', ')}`);
    }
}

main();
