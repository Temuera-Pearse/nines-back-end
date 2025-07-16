// File: src/Gateways/IExchangeGateway.cs
using System.Threading.Tasks;

namespace Nines.BackEnd.Gateways
{
    /// <summary>
    /// Abstraction for any external exchange or payment API.
    /// </summary>
    public interface IExchangeGateway
    {
        /// <summary>
        /// Retrieves the current exchange rate from one currency to another.
        /// </summary>
        Task<decimal> GetExchangeRateAsync(string fromCurrency, string toCurrency);

        /// <summary>
        /// Executes a currency conversion or place‐bet operation.
        /// Returns true if successful.
        /// </summary>
        Task<bool> ExecuteConversionAsync(
            string fromCurrency,
            string toCurrency,
            decimal amount);
    }
}
