// File: src/Gateways/ExchangeGateway.cs
using System;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;

namespace Nines.BackEnd.Gateways
{
    /// <summary>
    /// A simple HttpClient‐based gateway. Replace the URLs and payloads with your actual API.
    /// </summary>
    public class ExchangeGateway : IExchangeGateway
    {
        private readonly HttpClient _http;

        public ExchangeGateway(HttpClient http)
        {
            _http = http;
        }

        public async Task<decimal> GetExchangeRateAsync(string fromCurrency, string toCurrency)
        {
            // Example: GET https://api.example.com/rate?from=USD&to=BTC
            var url = $"https://api.example.com/rate?from={fromCurrency}&to={toCurrency}";
            var response = await _http.GetFromJsonAsync<ExchangeRateResponse>(url)
                                ?? throw new Exception("Invalid rate response");
            return response.Rate;
        }

        public async Task<bool> ExecuteConversionAsync(
            string fromCurrency,
            string toCurrency,
            decimal amount)
        {
            // Example: POST https://api.example.com/convert { from, to, amount }
            var payload = new {
                from = fromCurrency,
                to   = toCurrency,
                amt  = amount
            };
            var resp = await _http.PostAsJsonAsync(
                "https://api.example.com/convert",
                payload);

            return resp.IsSuccessStatusCode;
        }

        // Helper type for JSON deserialization
        private class ExchangeRateResponse
        {
            public decimal Rate { get; set; }
        }
    }
}
