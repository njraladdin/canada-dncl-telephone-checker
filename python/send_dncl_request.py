import requests
import json
import time
from typing import Optional, Dict, Any
import os
from dotenv import load_dotenv
import asyncio

load_dotenv()

class TokenExpiredError(Exception):
    """Custom exception to indicate when a token has expired/is invalid"""
    pass

def format_phone_number(phone: str) -> str:
    """Trim whitespace, take first 12 characters (###-###-####), and remove dashes"""
    return phone.strip()[:12].replace('-', '')

async def send_dncl_request(phone_number: str, token: str, max_retries: int = 3) -> Dict[str, Any]:
    """
    Send request to DNCL API to check phone number registration status
    """
    formatted_phone = format_phone_number(phone_number)
    
    data = {
        "Phone": formatted_phone
    }

    # Add logging for token usage
    print(f"Using token (first 50 chars): {token[:50]}...")
    print(f"Token length: {len(token)}")

    # Add a small delay before using a new token
    await asyncio.sleep(5.5)  # 1.5 second delay to allow token to be fully activated

    for attempt in range(1, max_retries + 1):
        if attempt > 1:
            print(f"Retry attempt {attempt}/{max_retries}")
            time.sleep(1)  # 1 second delay between retries

        proxy_config = {
            'http': 'http://juuwqkin-rotate:tif49vweo33s@p.webshare.io:80',
            'https': 'http://juuwqkin-rotate:tif49vweo33s@p.webshare.io:80'
        }

        headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en',
            'authorization-captcha': token,
            'content-type': 'application/json;charset=UTF-8',
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
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        }

        print('dncl request')
        print(f"Phone: {formatted_phone}")
        print(f"Token: {token[:50]}...")
        print(f"Headers: {headers}")

        try:
            response = requests.post(
                'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
                json=data,
                headers=headers,
              #  proxies=proxy_config,
                timeout=60
            )
            
            # Log response status and content
            print(f"Response status: {response.status_code}")
            print(f"Response content: {response.text[:200]}...")  # First 200 chars
            
            if response.status_code == 400:
                error_data = response.json()
                model_state = error_data.get("ModelState", {})
                
                # Check for invalid area code
                if "model.Phone" in model_state and "area code is invalid" in model_state["model.Phone"][0].lower():
                    return {
                        'Phone': formatted_phone,
                        'status': 'INVALID',
                        'error': 'Invalid area code'
                    }
                
                # Check for invalid token
                if "Authorization-Captcha" in model_state:
                    print("Token validation failed - raising TokenExpiredError")
                    raise TokenExpiredError("Token expired or invalid")
                
                # Any other 400 error - return immediately without retry
                return {
                    'Phone': formatted_phone,
                    'status': 'ERROR',
                    'error': error_data
                }
            
            response.raise_for_status()
            print(f"API Response for {phone_number}:", json.dumps(response.json()))
            return response.json()

        except TokenExpiredError:
            # Always raise TokenExpiredError to get a new token
            raise

        except requests.exceptions.RequestException as error:
            # Handle 404 case immediately without retrying
            if getattr(error.response, 'status_code', None) == 404:
                return {
                    'Phone': formatted_phone,
                    'Active': False,
                    'AddedAt': None
                }

            print(f"Attempt {attempt}/{max_retries} failed for {phone_number}:", 
                  error.response.json() if error.response else str(error))
            
            # If this is the last attempt, return ERROR status
            if attempt == max_retries:
                return {
                    'Phone': formatted_phone,
                    'status': 'ERROR',
                    'error': error.response.json() if error.response else str(error)
                }

    return {
        'Phone': formatted_phone,
        'status': 'ERROR',
        'error': 'Max retries exceeded'
    }