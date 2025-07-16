// src/DTOs/HorseSummaryDto.cs
namespace Nines.BackEnd.DTOs
{
    /// <summary>
    /// A slimmed-down view of a Horse for API responses.
    /// </summary>
    public class HorseSummaryDto
    {
        /// <summary>
        /// The unique ID of the horse.
        /// </summary>
        public int Id { get; set; }

        /// <summary>
        /// The horse’s display name.
        /// </summary>
        public string Name { get; set; } = default!;

        /// <summary>
        /// The current odds for this horse.
        /// </summary>
        public decimal Odds { get; set; }
    }
}
 