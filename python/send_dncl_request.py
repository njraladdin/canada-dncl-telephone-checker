import requests
import json
import time
from typing import Optional, Dict, Any
import os
from dotenv import load_dotenv

load_dotenv()

def format_phone_number(phone: str) -> str:
    """Trim whitespace, take first 12 characters (###-###-####), and remove dashes"""
    return phone.strip()[:12].replace('-', '')

async def send_dncl_request(phone_number: str, token: str, max_retries: int = 3) -> Dict[str, Any]:
    """
    Send request to DNCL API to check phone number registration status
    
    Args:
        phone_number: Phone number to check
        token: Captcha token for authorization
        max_retries: Maximum number of retry attempts
        
    Returns:
        Dict containing API response or error status
    """
    formatted_phone = format_phone_number(phone_number)
    
    data = {
        "Phone": formatted_phone
    }

    for attempt in range(1, max_retries + 1):
        # Add delay before retries (skip delay on first attempt)
        if attempt > 1:
            time.sleep(1)  # 1 second delay

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
        print(data)
        print(headers)
        try:
            response = requests.post(
                'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
                json=data,
                headers=headers,
                proxies=proxy_config,  # Uncomment to enable proxy
                timeout=60
            )
            response.raise_for_status()
            print(f"API Response for {phone_number}:", json.dumps(response.json()))
            return response.json()

        except requests.exceptions.RequestException as error:
            # Handle 404 case immediately without retrying
            if getattr(error.response, 'status_code', None) == 404:
                return {
                    'Phone': formatted_phone,
                    'Active': False,
                    'AddedAt': None
                }

            # Return specific response for invalid phone numbers
            if error.response and 'area code is invalid' in str(error.response.json().get('ModelState', {}).get('model.Phone', [''])[0]):
                return {
                    'Phone': formatted_phone,
                    'status': 'INVALID',
                    'error': error.response.json()
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