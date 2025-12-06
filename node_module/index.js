// index.js

const fetch = require('node-fetch');
const admin = require('firebase-admin');

// 1. Initialize Firebase Admin SDK
let db;
try {
    // FIREBASE_SERVICE_ACCOUNT_JSON is stored as a string in the Lambda Environment Variables
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.");
    }
    
    // Parse the JSON string into an object
    const serviceAccount = JSON.parse(serviceAccountJson);

    // Initialize the app if it hasn't been already
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    db = admin.firestore();
} catch (error) {
    console.error("Firebase Initialization Error:", error);
    // Setting db to null will cause errors on Firestore access, but allows deployment
    db = null; 
}

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

/**
 * Calls the Google Places API to find nearby locations of a specific type.
 * @param {number} lat - Latitude of the search center.
 * @param {number} lng - Longitude of the search center.
 * @param {string} type - The type of place to search for (e.g., 'restaurant', 'hospital').
 * @returns {Array} List of places or an empty array.
 */
async function getNearbyPlaces(lat, lng, type) {
    if (!GOOGLE_PLACES_API_KEY) {
        console.error("GOOGLE_PLACES_API_KEY is missing.");
        return [];
    }
    
    // Increased radius to 20000m (20km) for better initial results
    const radius = 20000; 
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=${type}&key=${GOOGLE_PLACES_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            console.warn(`Google Places API returned status: ${data.status}`);
            return [];
        }

        return data.results || [];
    } catch (e) {
        console.error(`Error fetching places for type ${type}:`, e);
        return [];
    }
}

/**
 * Main handler for the AWS Lambda function.
 */
exports.handler = async (event) => {
    // API Gateway puts the payload in event.body, which needs to be parsed
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (e) {
        console.error("Error parsing event body:", e);
        return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON format" }) };
    }

    const { from, to, vehicle, userId, currentLocation } = body;
    
    if (!currentLocation || !currentLocation.lat || !currentLocation.lng) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing current location." }) };
    }

    const { lat, lng } = currentLocation;
    const timestamp = new Date().toISOString();

    // 1. Gather all Points of Interest (POIs)
    const poiTypes = ['restaurant', 'hospital', 'gas_station', 'lodging'];
    let allPois = [];

    await Promise.all(poiTypes.map(async (type) => {
        const places = await getNearbyPlaces(lat, lng, type);
        allPois = allPois.concat(places);
    }));

    // 2. Save Data to Firestore
    const tripData = {
        from,
        to,
        vehicle,
        userId,
        currentLocation,
        timestamp,
        pois: allPois.map(p => ({
            name: p.name,
            location: p.geometry.location,
            type: p.types[0],
            vicinity: p.vicinity 
        })),
        active: true // For the scheduled notification function
    };

    try {
        if (db) {
            await db.collection('trips').add(tripData);
            console.log(`Trip for user ${userId} saved successfully.`);
        } else {
            console.error("Firestore DB not initialized. Skipping save operation.");
        }
    } catch (dbError) {
        console.error("Error saving to Firestore:", dbError);
    }
    
    // 3. Prepare the response for the frontend
    const aiResponse = `Successfully planned trip from ${from} to ${to} by ${vehicle}. Found ${allPois.length} points of interest near your location.`;

    const response = {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" // Crucial for CORS
        },
        body: JSON.stringify({
            message: "Trip processed successfully.",
            ai_response: aiResponse,
            pois: allPois // Send the full list of POIs back to the frontend
        }),
    };

    return response;
};