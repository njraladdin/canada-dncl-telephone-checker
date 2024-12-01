const axios = require('axios');
const clc = require('cli-color');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function formatPhoneNumber(phone) {
    // Trim whitespace and take first 12 characters
    return phone.trim().slice(0, 12);
}

async function sendDNCLRequest(phoneNumber, token) {
    try {
        const formattedPhone = formatPhoneNumber(phoneNumber);
        
        const response = await axios.post('https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check', 
            {
                "Phone": formattedPhone
            },
            {
                headers: { 
                    'accept': 'application/json, text/plain, */*', 
                    'accept-language': 'en', 
                    'authorization-captcha': token,
                    'dnt': '1', 
                    'origin': 'https://lnnte-dncl.gc.ca', 
                    'priority': 'u=1, i', 
                    'referer': 'https://lnnte-dncl.gc.ca/', 
                    'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 
                    'sec-ch-ua-mobile': '?0', 
                    'sec-ch-ua-platform': '"Windows"', 
                    'sec-fetch-dest': 'empty', 
                    'sec-fetch-mode': 'cors', 
                    'sec-fetch-site': 'same-site', 
                    'user-agent': USER_AGENT,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('\n=== API Response ===');
        console.log(`Status Code: ${clc.green(response.status)}`);
        console.log(`Phone Number: ${clc.yellow(formattedPhone)}`);
        console.log(`Status: ${clc.green('ACTIVE')}`);
        console.log('Response Data:', clc.cyan(JSON.stringify(response.data, null, 2)));
        console.log('==================\n');
        
        return {
            status: 'ACTIVE',
            registrationDate: response.data.AddedAt
        };

    } catch (error) {
        const formattedPhone = formatPhoneNumber(phoneNumber);
        
        if (error.response?.status === 404) {
            console.log('\n=== API Response ===');
            console.log(`Status Code: ${clc.yellow(error.response.status)}`);
            console.log(`Phone Number: ${clc.yellow(formattedPhone)}`);
            console.log(`Status: ${clc.yellow('INACTIVE')}`);
            console.log('==================\n');
            
            return {
                status: 'INACTIVE',
                registrationDate: null
            };
        }

        if (error.response?.status === 400) {
            console.error('\n=== API Error (400) ===');
            console.error(`Status Code: ${clc.red(error.response.status)}`);
            console.error(`Phone Number: ${clc.yellow(formattedPhone)}`);
            console.error(`Error Message: ${clc.red(error.message)}`);
            console.error('Response Data:', clc.red(JSON.stringify(error.response.data, null, 2)));
            if (error.response.data?.message) {
                console.error('Error Text:', clc.red(error.response.data.message));
            }
            console.error('=====================\n');
            
            // Check if the error is due to invalid area code
            if (error.response.data?.ModelState?.['model.Phone']?.includes('Phone number area code is invalid.')) {
                return {
                    status: 'INVALID',
                    registrationDate: null
                };
            }
            
            return {
                status: 'ERROR',
                registrationDate: null
            };
        }
        
        console.error('\n=== API Error ===');
        console.error(`Status Code: ${clc.red(error.response?.status || 'N/A')}`);
        console.error(`Phone Number: ${clc.yellow(formattedPhone)}`);
        console.error(`Error Message: ${clc.red(error.message)}`);
        if (error.response?.data) {
            console.error('Response Data:', clc.red(JSON.stringify(error.response.data, null, 2)));
        }
        console.error('==================\n');
        
        return null;
    }
}

// Export both functions
module.exports = { sendDNCLRequest, formatPhoneNumber };

// Add ability to test directly
if (require.main === module) {
    // Test the function with a sample token and phone number
    const testToken = process.argv[2] || 'your-test-token';
    const testPhone = process.argv[3] || '1234567890';
    
    console.log('Testing DNCL Request...');
    console.log(`Original phone number: ${testPhone}`);
    console.log(`Formatted phone number: ${formatPhoneNumber(testPhone)}`);
    
    sendDNCLRequest(testPhone, testToken)
        .then(result => console.log('Test Result:', result))
        .catch(error => console.error('Test Error:', error));
} 