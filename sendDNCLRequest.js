const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const dotenv = require('dotenv');
dotenv.config();

function formatPhoneNumber(phone) {
    // Trim whitespace and take first 12 characters (###-###-####)
    return phone.trim().slice(0, 12);
}

async function sendDNCLRequest(phoneNumber, token, maxRetries = 3) {
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    let data = JSON.stringify({
        "Phone": formattedPhone
    });



    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxyAgent = new HttpsProxyAgent({
            host: process.env.PROXY_HOST,
            port: process.env.PROXY_PORT,
            auth: `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`
        });
    
        let config = {
            method: 'post',
            maxBodyLength: Infinity,
            url: 'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
            httpsAgent: proxyAgent,
            headers: { 
                'accept': 'application/json, text/plain, */*', 
                'accept-language': 'en', 
                'authorization-captcha': token,
                'content-type': 'application/json;charset=UTF-8', 
                'origin': 'https://lnnte-dncl.gc.ca', 
                'priority': 'u=1, i', 
                'referer': 'https://lnnte-dncl.gc.ca/', 
                'sec-fetch-dest': 'empty', 
                'sec-fetch-mode': 'cors', 
                'sec-fetch-site': 'same-site', 
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            data: data
        };

        try {
            const response = await axios.request(config);
            console.log(`API Response for ${phoneNumber}:`, JSON.stringify(response.data));
            return response.data;
        } catch (error) {
            // Handle 404 case immediately without retrying
            if (error.response?.status === 404) {
                return {
                    Phone: formattedPhone,
                    Active: false,
                    AddedAt: null
                };
            }

            // Return specific response for invalid phone numbers
            if (error.response?.data?.ModelState?.['model.Phone']?.[0]?.includes('area code is invalid')) {
                return {
                    Phone: formattedPhone,
                    status: 'INVALID',
                    error: error.response.data
                };
            }

            console.error(`Attempt ${attempt}/${maxRetries} failed for ${phoneNumber}:`, error.response?.data || error.message);
            
            // If this is the last attempt, return ERROR status
            if (attempt === maxRetries) {
                return {
                    Phone: formattedPhone,
                    status: 'ERROR',
                    error: error.response?.data || error.message
                };
            }
        }
    }
}

module.exports = sendDNCLRequest;